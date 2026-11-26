import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

export { createServer } from './server.js';
export { MoodleClient, MoodleError, ALLOWED_READ_FUNCTIONS, parseMoodleDashboard, stripHtml, unixToIso } from './client.js';

export async function startStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
