import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Session, StoredSessionSchema } from '../../../vendor/blackboard/src/auth/session.js';
import { ConfigSchema } from '../../../vendor/blackboard/src/config.js';
import { HttpClient } from '../../../vendor/blackboard/src/client/http.js';
import { expand } from '../../../vendor/blackboard/src/client/endpoints.js';
import { LmsError } from '../../errors.js';
import type { PlatformRuntime } from '../types.js';

export async function serializeSession(session: Session): Promise<string> {
  return JSON.stringify({ version: 1, baseUrl: session.baseUrl, jar: await session.jar.serialize(),
    xsrfToken: session.xsrfToken, userAgent: session.userAgent, capturedAt: session.capturedAt.toISOString(), user: session.user, idpHosts: [] });
}

export const runtime: PlatformRuntime = {
  configure({ origin, stateHome, profileId }) {
    process.env.BLACKBOARD_URL = origin;
    process.env.BLACKBOARD_MCP_HOME = join(stateHome, `runtime-${profileId}`);
    process.env.BLACKBOARD_MCP_DOWNLOAD_DIR = join(stateHome, 'downloads', profileId);
    process.env.BLACKBOARD_MCP_ALLOW_WRITES = '0';
    process.env.BLACKBOARD_MCP_LOG_LEVEL = 'error';
    process.env.BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES = String(30 * 1024 * 1024);
  },
  async validate({ origin }, candidate) {
    if (candidate.kind !== 'cookie') throw new Error('Blackboard requires a cookie session');
    const session = await Session.fromCookieHeader(origin, candidate.value, { userAgent: candidate.userAgent });
    session.persist = async () => {}; // A failed probe cannot overwrite a last-good session.
    const http = new HttpClient(session, ConfigSchema.parse({ baseUrl: origin, allowWrites: false }));
    const me = await http.json<{ id?: string }>({ path: expand('self'), retries: 0, allowRefresh: false });
    if (!me.id) throw new Error('Identity probe failed');
    return { kind: 'blackboard-session', value: await serializeSession(session), validatedAt: new Date().toISOString() };
  },
  async install({ origin }, credential, persist) {
    // Redirect only persistence; endpoint mappings, HTTP, pagination and handlers stay upstream.
    Session.load = async () => {
      if (!credential || credential.kind !== 'blackboard-session') throw new LmsError('AUTH_REQUIRED', 'Sign in with lms auth login.');
      const stored = StoredSessionSchema.parse(JSON.parse(credential.value));
      if (stored.baseUrl !== origin) throw new Error('Session origin mismatch');
      return new Session(stored.baseUrl, await CookieJar.deserialize(stored.jar as never), stored.xsrfToken, stored.userAgent ?? '', new Date(stored.capturedAt), stored.user, []);
    };
    Session.prototype.persist = async function () {
      if (credential) await persist({ ...credential, value: await serializeSession(this) });
    };
  },
  async serve() {
    const { createServer } = await import('../../../vendor/blackboard/src/server.js');
    // No upstream browser-cookie import, CLI login, or SSO session keeper.
    await createServer().connect(new StdioServerTransport());
  },
};
