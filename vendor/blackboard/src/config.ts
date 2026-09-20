import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { configPath, stateDir, ensureDir, downloadDir } from './lib/paths.js';
import { BlackboardError } from './lib/errors.js';

export const ConfigSchema = z.object({
  /** Origin of the Blackboard instance, e.g. "https://blackboard.example.edu". */
  baseUrl: z.string().url(),
  /** Human label shown in tool output; defaults to the hostname. */
  label: z.string().optional(),
  /** Cap on rows returned by list tools before pagination kicks in. */
  pageSize: z.number().int().min(1).max(500).default(50),
  /** Refuse downloads larger than this (bytes). Guards context and disk. */
  maxDownloadBytes: z.number().int().min(1024).default(100 * 1024 * 1024),
  /** Directory attachments are written to. */
  downloadDir: z.string().optional(),
  /** Whether tools that mutate remote state are permitted at all. */
  allowWrites: z.boolean().default(false),
  /** Extra hostnames the HTTP client may follow redirects to (CDN/file hosts). */
  extraHosts: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Env overrides win over the config file, so CI and per-client setups stay declarative. */
function envOverrides(): Partial<Config> {
  const out: Record<string, unknown> = {};
  const url = process.env.BLACKBOARD_URL;
  if (url) out.baseUrl = normaliseBaseUrl(url);
  if (process.env.BLACKBOARD_MCP_PAGE_SIZE) {
    out.pageSize = Number(process.env.BLACKBOARD_MCP_PAGE_SIZE);
  }
  if (process.env.BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES) {
    out.maxDownloadBytes = Number(process.env.BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES);
  }
  if (process.env.BLACKBOARD_MCP_ALLOW_WRITES !== undefined) {
    out.allowWrites = process.env.BLACKBOARD_MCP_ALLOW_WRITES === '1';
  }
  if (process.env.BLACKBOARD_MCP_DOWNLOAD_DIR) {
    out.downloadDir = process.env.BLACKBOARD_MCP_DOWNLOAD_DIR;
  }
  return out as Partial<Config>;
}

export function normaliseBaseUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BlackboardError('BAD_INPUT', `Not a valid Blackboard URL: ${input}`, {
      hint: 'Pass the origin only, e.g. https://blackboard.your-university.edu',
    });
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new BlackboardError('BAD_INPUT', 'Blackboard URL must use https.', {
      hint: 'Session cookies are only sent over TLS; plain http would leak them.',
    });
  }
  return url.origin;
}

export function loadConfigOrNull(): Config | null {
  const file = configPath();
  const raw = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {};
  const merged = { ...raw, ...envOverrides() };
  if (!merged.baseUrl) return null;
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BlackboardError('NOT_CONFIGURED', `Invalid config at ${file}`, {
      hint: 'Delete the file and re-run `blackboard-mcp auth login`.',
      detail: parsed.error.flatten(),
    });
  }
  const cfg = parsed.data;
  if (!cfg.downloadDir) cfg.downloadDir = downloadDir();
  if (!cfg.label) cfg.label = new URL(cfg.baseUrl).hostname;
  return cfg;
}

export function saveConfig(patch: Partial<Config>): Config {
  const file = configPath();
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {};
  const merged = ConfigSchema.parse({ ...existing, ...patch });
  ensureDir(stateDir());
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
