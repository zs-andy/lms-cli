import { CookieJar } from 'tough-cookie';
import { Session, StoredSessionSchema } from '../vendor/blackboard/src/auth/session.js';
import { ConfigSchema } from '../vendor/blackboard/src/config.js';
import { HttpClient } from '../vendor/blackboard/src/client/http.js';
import { expand } from '../vendor/blackboard/src/client/endpoints.js';
import { join } from 'node:path';
import { type Platform, type Profile, stateHome } from './config.js';
import { type Secret, vault } from './vault.js';
import { LmsError } from './errors.js';

export function configureEnvironment(p: Profile, platform: Platform) {
  // Never inherit credentials, write permissions, state paths, or debug logging from another setup.
  for (const k of Object.keys(process.env)) if (k.startsWith('CANVAS_') || k.startsWith('BLACKBOARD_')) delete process.env[k];
  if (platform === 'canvas') { process.env.CANVAS_BASE_URL = p.canvas!; process.env.CANVAS_NO_KEYCHAIN = '1'; }
  else {
    process.env.BLACKBOARD_URL = p.blackboard!;
    process.env.BLACKBOARD_MCP_HOME = join(stateHome(), `runtime-${p.id}`);
    process.env.BLACKBOARD_MCP_DOWNLOAD_DIR = join(stateHome(), 'downloads', p.id);
    process.env.BLACKBOARD_MCP_ALLOW_WRITES = '0'; process.env.BLACKBOARD_MCP_LOG_LEVEL = 'error';
    process.env.BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES = String(30 * 1024 * 1024);
  }
}
export async function serializeSession(session: Session): Promise<string> {
  return JSON.stringify({ version: 1, baseUrl: session.baseUrl, jar: await session.jar.serialize(),
    xsrfToken: session.xsrfToken, userAgent: session.userAgent, capturedAt: session.capturedAt.toISOString(), user: session.user, idpHosts: [] });
}

/** Adapter uses upstream HTTP clients for validation; passwords and IdP cookies never enter here. */
export async function validateCredential(p: Profile, platform: Platform, candidate: Omit<Secret, 'validatedAt'>): Promise<Secret> {
  configureEnvironment(p, platform);
  if (!p[platform]) throw new LmsError('NOT_CONFIGURED', 'Platform is not configured for this profile.');
  if (!candidate.value || candidate.value.length > 200_000 || /[\r\n]/.test(candidate.value)) throw new LmsError('BAD_INPUT', 'Invalid credential input.');
  try {
    if (platform === 'canvas') {
      if (candidate.kind === 'token') process.env.CANVAS_API_TOKEN = candidate.value;
      else if (candidate.kind === 'cookie') process.env.CANVAS_COOKIE = candidate.value;
      else throw new Error();
      if (candidate.userAgent) process.env.CANVAS_USER_AGENT = candidate.userAgent;
      // Validation runs in an isolated process, so the upstream credential cache cannot be stale.
      const { canvasGet } = await import('../vendor/canvas/src/canvas.js');
      const me = await canvasGet('/users/self/profile');
      if (!me?.id) throw new Error();
      return { ...candidate, validatedAt: new Date().toISOString() };
    }
    if (candidate.kind !== 'cookie') throw new Error();
    const s = await Session.fromCookieHeader(p.blackboard!, candidate.value, { userAgent: candidate.userAgent });
    // A failed probe must not overwrite the last-good session.
    s.persist = async () => {};
    const config = ConfigSchema.parse({ baseUrl: p.blackboard!, allowWrites: false });
    const http = new HttpClient(s, config);
    const me = await http.json<{ id?: string }>({ path: expand('self'), retries: 0, allowRefresh: false });
    if (!me.id) throw new Error();
    return { kind: 'blackboard-session', value: await serializeSession(s), validatedAt: new Date().toISOString() };
  } catch { throw new LmsError('AUTH_FAILED', 'The platform did not confirm this session.', 'Finish the school login and MFA. Expired or rejected sessions do not replace existing credentials.'); }
}

export async function installCredentials(p: Profile, platform: Platform) {
  configureEnvironment(p, platform);
  const stored = await vault.read<Secret>(p, platform);
  if (platform === 'canvas') {
    if (stored?.value.kind === 'token') process.env.CANVAS_API_TOKEN = stored.value.value;
    if (stored?.value.kind === 'cookie') process.env.CANVAS_COOKIE = stored.value.value;
    if (stored?.value.userAgent) process.env.CANVAS_USER_AGENT = stored.value.userAgent;
    return;
  }
  // Redirect only the upstream session persistence boundary to the portable vault.
  // The HTTP client, pagination, endpoint mappings, parsers and tool handlers remain upstream.
  Session.load = async () => {
    if (!stored || stored.value.kind !== 'blackboard-session') throw new LmsError('AUTH_REQUIRED', 'Sign in with lms auth login.');
    const s = StoredSessionSchema.parse(JSON.parse(stored.value.value));
    if (s.baseUrl !== p.blackboard) throw new Error('Session origin mismatch');
    return new Session(s.baseUrl, await CookieJar.deserialize(s.jar as never), s.xsrfToken, s.userAgent ?? '', new Date(s.capturedAt), s.user, []);
  };
  Session.prototype.persist = async function () {
    if (!stored) return;
    await vault.write(p, platform, { ...stored.value, value: await serializeSession(this) }, stored.generation);
  };
}
