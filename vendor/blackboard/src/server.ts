import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { loadConfigOrNull } from './config.js';
import { log } from './lib/logger.js';

import { createRequire } from 'node:module';

export const SERVER_NAME = 'blackboard-mcp';

/**
 * Read from package.json rather than hardcoded, so the CLI and the MCP
 * handshake can never advertise a version that differs from the published one.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Builds the MCP server with every tool, prompt and resource registered.
 *
 * Deliberately does not touch the network or the stored session: a client that
 * lists capabilities must succeed even when the user has not signed in yet, so
 * authentication is resolved lazily on the first tool call and surfaces as an
 * actionable error rather than a startup crash.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Blackboard Learn access for the signed-in student or instructor.',
        '',
        'Start with `bb_list_courses`. Every other course tool needs the `courseId`',
        'it returns (an internal id like `_12345_1`, not the human course code).',
        '',
        'Common routes:',
        '  - "what is due?"            -> bb_todo',
        '  - "what changed recently?"  -> bb_activity_stream, bb_announcements',
        '  - "what is in this course?" -> bb_browse_course',
        '  - "read this document"      -> bb_read_file (pages through long PDFs)',
        '  - "how am I doing?"         -> bb_grade_summary, then bb_list_grades',
        '  - "what did the instructor say?" -> bb_get_grade_detail (feedback lives here)',
        '  - anything unmodelled      -> bb_list_endpoints, then bb_raw_request',
        '',
        'The server is read-only unless BLACKBOARD_MCP_ALLOW_WRITES=1 is set.',
        'If a tool reports SESSION_EXPIRED, the user must re-run',
        '`blackboard-mcp auth login` in a terminal. It cannot be fixed from here.',
      ].join('\n'),
    },
  );

  registerAllTools(server);
  registerPrompts(server);
  registerResources(server);

  return server;
}

/** Runs the server over stdio, the transport every desktop MCP client uses. */
export async function startStdio(): Promise<void> {
  const config = loadConfigOrNull();
  log.info(
    config
      ? `Starting ${SERVER_NAME} v${SERVER_VERSION} for ${config.baseUrl}`
      : `Starting ${SERVER_NAME} v${SERVER_VERSION} (not yet configured. Run \`blackboard-mcp auth login\`)`,
  );

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the Blackboard session alive in the background so a long-running
  // client session never hits an expiry mid-conversation. Failure here is not
  // fatal: the user may simply not have signed in yet.
  let stopKeeper: (() => void) | undefined;
  void (async () => {
    try {
      const { BlackboardClient } = await import('./client/index.js');
      const client = await BlackboardClient.create();
      stopKeeper = client.startSessionKeeper();
      log.debug('Session keeper started');
    } catch (err) {
      log.debug('Session keeper not started', (err as Error).message);
    }
  })();

  // Keep the shutdown quiet and prompt: clients kill the process on close.
  const shutdown = () => {
    log.info('Shutting down');
    stopKeeper?.();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
