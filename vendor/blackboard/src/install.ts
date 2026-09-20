import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { BlackboardError } from './lib/errors.js';

/**
 * MCP client registration.
 *
 * Every client stores server definitions in its own file, under its own key
 * (`mcpServers` vs `servers` vs TOML tables), so "install it in my editor" is
 * really six slightly different edits. This centralises them.
 */

export type ClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'codex'
  | 'vscode'
  | 'windsurf'
  | 'zed';

export interface ClientSpec {
  id: ClientId;
  label: string;
  /** Absolute config path, or null when the client is configured by CLI only. */
  configPath: string | null;
  /** Top-level key servers live under. */
  key: 'mcpServers' | 'servers' | 'context_servers';
  format: 'json' | 'toml';
  /** Shown instead of a file edit when the client prefers its own command. */
  command?: string;
  /** Project-scoped rather than user-scoped. */
  projectScoped?: boolean;
}

const home = homedir();
const isMac = platform() === 'darwin';
const isWin = platform() === 'win32';

function appSupport(...parts: string[]): string {
  if (isMac) return join(home, 'Library', 'Application Support', ...parts);
  if (isWin) return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), ...parts);
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), ...parts);
}

export const CLIENTS: Record<ClientId, ClientSpec> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: join(home, '.claude.json'),
    key: 'mcpServers',
    format: 'json',
    command: 'claude mcp add blackboard -- npx -y blackboard-mcp',
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: appSupport('Claude', 'claude_desktop_config.json'),
    key: 'mcpServers',
    format: 'json',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    configPath: join(home, '.cursor', 'mcp.json'),
    key: 'mcpServers',
    format: 'json',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    configPath: join(home, '.codex', 'config.toml'),
    key: 'mcpServers',
    format: 'toml',
  },
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    configPath: join(process.cwd(), '.vscode', 'mcp.json'),
    key: 'servers',
    format: 'json',
    projectScoped: true,
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers',
    format: 'json',
  },
  zed: {
    id: 'zed',
    label: 'Zed',
    configPath: join(home, '.config', 'zed', 'settings.json'),
    key: 'context_servers',
    format: 'json',
  },
};

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The server definition to register.
 *
 * `npx -y` rather than a global install: it keeps the client config valid
 * regardless of how the user installed the package, and picks up updates.
 */
export function serverEntry(opts: { local?: boolean; allowWrites?: boolean } = {}): ServerEntry {
  const env: Record<string, string> = {};
  if (opts.allowWrites) env.BLACKBOARD_MCP_ALLOW_WRITES = '1';

  const entry: ServerEntry = opts.local
    ? { command: process.execPath, args: [join(process.cwd(), 'dist', 'cli.js')] }
    : { command: 'npx', args: ['-y', 'blackboard-mcp'] };

  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

/**
 * Per-client entry shape.
 *
 * Every client but Zed accepts `{command, args}` directly. Zed nests the launch
 * command under `command: {path, args}`. Its schema has shifted between
 * releases, so treat the Zed output as a starting point rather than gospel.
 */
function shapeFor(client: ClientSpec, entry: ServerEntry): Record<string, unknown> {
  if (client.id === 'zed') {
    return {
      source: 'custom',
      command: { path: entry.command, args: entry.args, ...(entry.env ? { env: entry.env } : {}) },
    };
  }
  return { ...entry };
}

/** Renders the TOML block Codex expects. */
export function tomlBlock(entry: ServerEntry): string {
  const lines = [
    '[mcp_servers.blackboard]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ];
  if (entry.env) {
    lines.push('');
    lines.push('[mcp_servers.blackboard.env]');
    for (const [k, v] of Object.entries(entry.env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

export interface InstallResult {
  client: ClientSpec;
  written: boolean;
  path: string | null;
  snippet: string;
  note?: string;
}

/**
 * Registers the server with one client.
 *
 * JSON configs are merged rather than overwritten: these files hold the user's
 * other MCP servers and unrelated settings, and clobbering them to add one
 * entry would be indefensible. TOML is printed for the user to paste, since
 * merging TOML correctly needs a real parser.
 */
export function install(
  clientId: ClientId,
  opts: { write?: boolean; local?: boolean; allowWrites?: boolean } = {},
): InstallResult {
  const client = CLIENTS[clientId];
  if (!client) {
    throw new BlackboardError('BAD_INPUT', `Unknown client "${clientId}".`, {
      hint: `Known clients: ${Object.keys(CLIENTS).join(', ')}`,
    });
  }

  const entry = serverEntry(opts);

  if (client.format === 'toml') {
    return {
      client,
      written: false,
      path: client.configPath,
      snippet: tomlBlock(entry),
      note: `Append this to ${client.configPath}. TOML is not merged automatically to avoid corrupting the file.`,
    };
  }

  const payload = shapeFor(client, entry);
  const snippet = JSON.stringify({ [client.key]: { blackboard: payload } }, null, 2);

  if (!opts.write || !client.configPath) {
    return {
      client,
      written: false,
      path: client.configPath,
      snippet,
      note: client.command
        ? `Either run: ${client.command}\nOr merge the snippet into ${client.configPath}`
        : `Merge the snippet into ${client.configPath}`,
    };
  }

  // Merge into whatever is already there.
  let existing: Record<string, unknown> = {};
  if (existsSync(client.configPath)) {
    try {
      existing = JSON.parse(readFileSync(client.configPath, 'utf8')) as Record<string, unknown>;
    } catch (cause) {
      throw new BlackboardError('BAD_INPUT', `${client.configPath} is not valid JSON.`, {
        hint: 'Fix or move the file, then retry. It was left untouched.',
        cause,
      });
    }
  }

  const bucket = (existing[client.key] as Record<string, unknown> | undefined) ?? {};
  const already = bucket.blackboard !== undefined;
  bucket.blackboard = payload;
  existing[client.key] = bucket;

  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(client.configPath, `${JSON.stringify(existing, null, 2)}\n`);

  return {
    client,
    written: true,
    path: client.configPath,
    snippet,
    note: `${already ? 'Updated' : 'Added'} the "blackboard" server in ${client.configPath}. Restart ${client.label} to pick it up.`,
  };
}
