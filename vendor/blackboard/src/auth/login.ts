import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { Session, DEFAULT_USER_AGENT } from './session.js';
import { saveConfig, normaliseBaseUrl, loadConfigOrNull, type Config } from '../config.js';
import { BlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { HttpClient } from '../client/http.js';
import { expand } from '../client/endpoints.js';
import { displayName } from '../client/index.js';
import type { BbUser } from '../client/types.js';
import {
  discoverProfiles, discoverInstances, readBrowserCookies, IDP_COOKIE_HOSTS,
  type BrowserProfile,
} from './browsers.js';
import { refreshSession, discoverIdpHosts } from './saml.js';

/**
 * Extracts a `Cookie` header value from pasted input.
 *
 * Three shapes are accepted, because users reach for whichever their browser
 * offers first:
 *   1. A `curl` command from Chrome/Firefox "Copy as cURL". Cookies arrive in
 *      either `-b '...'` or `-H 'cookie: ...'`.
 *   2. A bare `Cookie:` header line copied out of the Network panel.
 *   3. A raw `name=value; name=value` string.
 *
 * cURL is the recommended route: Blackboard's `BbRouter` cookie is HttpOnly,
 * so it is invisible to `document.cookie` and cannot be copied from the
 * console. It only appears on a real request.
 */
export function parseCookieInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new BlackboardError('BAD_INPUT', 'Nothing was pasted.', {
      hint: 'Copy a signed-in request from your browser (DevTools > Network > right-click > Copy as cURL) and paste it.',
    });
  }

  // 1. curl: -b/--cookie, or a cookie request header.
  const bFlag = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/.exec(trimmed);
  if (bFlag?.[2]) return bFlag[2].trim();

  const headerFlag = /(?:^|\s)(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/i.exec(trimmed);
  if (headerFlag?.[2]) return headerFlag[2].trim();

  // 2. A bare header line, possibly among other pasted headers.
  const bareHeader = /^\s*cookie\s*:\s*(.+)$/im.exec(trimmed);
  if (bareHeader?.[1]) return bareHeader[1].trim();

  // 3. Raw cookie string. Require at least one name=value pair to avoid
  //    accepting arbitrary pasted text.
  if (/[^;=\s]+=[^;]*/.test(trimmed) && !trimmed.startsWith('curl')) {
    return trimmed;
  }

  throw new BlackboardError('BAD_INPUT', 'Could not find a Cookie header in what you pasted.', {
    hint: 'In DevTools > Network, click any request to your Blackboard host, then right-click > Copy > Copy as cURL, and paste the whole command.',
  });
}

/** Pulls the User-Agent out of a pasted cURL so our requests match the browser's. */
export function parseUserAgent(input: string): string | undefined {
  const m = /(?:-H|--header)\s+(['"])\s*user-agent\s*:\s*([\s\S]*?)\1/i.exec(input);
  return m?.[2]?.trim();
}

/** Infers the instance origin from a pasted cURL's target URL. */
export function parseBaseUrl(input: string): string | undefined {
  const m = /curl\s+(['"]?)(https?:\/\/[^\s'"]+)\1/.exec(input);
  if (!m?.[2]) return undefined;
  try {
    return new URL(m[2]).origin;
  } catch {
    return undefined;
  }
}

/** Opens a URL in the user's default browser, best-effort. */
export async function openBrowser(url: string): Promise<boolean> {
  const cmd =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    execFile(cmd, [url], (err) => resolve(!err));
  });
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Reads a multi-line paste, terminated by a blank line or EOF. */
function askMultiline(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const lines: string[] = [];
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      // A pasted cURL is one very long logical line, but shells wrap it with
      // trailing backslashes; keep reading until a genuinely empty line.
      if (line.trim() === '' && lines.length > 0) {
        rl.close();
        return;
      }
      if (line.trim() !== '') lines.push(line.replace(/\\$/, ''));
    });
    rl.on('close', () => resolve(lines.join(' ')));
  });
}

export interface BrowserLoginResult {
  user: BbUser;
  baseUrl: string;
  profile: BrowserProfile;
  /** True when the browser's cookie was stale and silent refresh renewed it. */
  refreshed: boolean;
  /** Whether the identity-provider cookies needed for future refresh are present. */
  canAutoRefresh: boolean;
  idpHosts: string[];
}

/**
 * Signs in by importing the session from the user's own browser.
 *
 * This asks the user nothing at all in the common case: Blackboard's `BbRouter`
 * cookie identifies both that a session exists and which host it belongs to,
 * so the instance is discovered rather than typed. Candidates are then verified
 * against the live API, because cookie presence alone does not prove validity.
 *
 * Identity-provider cookies are imported alongside, which is what allows the
 * session to be renewed silently for as long as the IdP session lives. Weeks,
 * typically, versus Blackboard's few hours.
 */
export async function loginFromBrowser(
  opts: { url?: string; profileHint?: string } = {},
): Promise<BrowserLoginResult> {
  const profiles = discoverProfiles();
  if (profiles.length === 0) {
    throw new BlackboardError('NOT_FOUND', 'No browser profiles found on this machine.', {
      hint: 'Sign in to Blackboard in Chrome, Edge, Brave or Firefox first, then retry. Or use `blackboard-mcp auth login --paste`.',
    });
  }

  const filtered = opts.profileHint
    ? profiles.filter((p) => p.label.toLowerCase().includes(opts.profileHint!.toLowerCase()))
    : profiles;
  if (filtered.length === 0) {
    throw new BlackboardError('NOT_FOUND', `No browser profile matching "${opts.profileHint}".`, {
      hint: `Available: ${profiles.map((p) => p.label).join(', ')}`,
    });
  }

  let candidates = await discoverInstances(filtered);
  if (opts.url) {
    const wanted = new URL(normaliseBaseUrl(opts.url)).hostname;
    candidates = candidates.filter((c) => c.host === wanted);
    if (candidates.length === 0) {
      throw new BlackboardError('NOT_FOUND', `No browser session found for ${wanted}.`, {
        hint: 'Sign in to that instance in your browser, then retry.',
      });
    }
  }
  if (candidates.length === 0) {
    throw new BlackboardError('NOT_FOUND', 'No Blackboard session found in any browser.', {
      hint: `Sign in to Blackboard in your browser first, then retry. Profiles checked: ${filtered
        .map((p) => p.label)
        .join(', ')}`,
    });
  }

  const failures: string[] = [];

  for (const candidate of candidates) {
    const baseUrl = normaliseBaseUrl(candidate.host);
    log.debug(`Trying ${baseUrl} from ${candidate.profile.label}`);

    // Ask Blackboard which provider it federates to, rather than guessing.
    // An unauthenticated probe names the host exactly, so only that provider's
    // cookies are read. The hardcoded list is a fallback for when the probe
    // cannot reach the instance.
    const discovered = await discoverIdpHosts(baseUrl)
      .then((r) => r.hosts)
      .catch(() => [] as string[]);
    const idpHosts = discovered.length > 0 ? discovered : IDP_COOKIE_HOSTS;
    if (discovered.length > 0) {
      log.info(`Identity provider for ${candidate.host}: ${discovered.join(', ')}`);
    } else {
      log.debug('Provider probe found nothing; falling back to the known-provider list');
    }

    let session: Session;
    try {
      const cookies = await readBrowserCookies(candidate.profile, [candidate.host, ...idpHosts]);
      session = await Session.fromBrowserCookies(baseUrl, cookies, {});
    } catch (err) {
      failures.push(`${candidate.host} (${candidate.profile.label}): ${(err as Error).message}`);
      continue;
    }

    const config = saveConfig({ baseUrl });
    let refreshed = false;

    // Verify against the live API. A cookie in the jar proves nothing about
    // whether Blackboard still honours it.
    let user = await probe(session, config);

    if (!user) {
      // Stale Blackboard cookie but possibly a live IdP session. This is the
      // normal case when the browser has been closed for a few hours.
      log.info('Browser session is stale; attempting silent renewal via the identity provider');
      const result = await refreshSession(session);
      if (result.ok) {
        refreshed = true;
        user = await probe(session, config);
      } else if (result.needsInteractiveLogin) {
        failures.push(`${candidate.host}: signed out. ${result.reason}`);
        continue;
      } else {
        failures.push(`${candidate.host}: ${result.reason ?? 'renewal failed'}`);
        continue;
      }
    }

    if (!user) {
      failures.push(`${candidate.host}: session rejected after renewal`);
      continue;
    }

    session.user = { id: user.id, userName: user.userName, displayName: displayName(user) };
    await session.persist();

    // Prove renewal works now, rather than promising it and failing in three
    // hours. This also narrows the pinned provider list and discards the
    // speculative cookies that had to be imported before the provider was known.
    let canAutoRefresh = false;
    try {
      const verify = await refreshSession(session, { force: true });
      canAutoRefresh = verify.ok;
      if (!verify.ok) {
        log.warn(`Renewal check failed: ${verify.reason ?? 'unknown'}`);
        // The forced walk set the session cookies aside; the working session is
        // untouched on failure, so re-probe to be certain it still functions.
        if (!(await probe(session, config))) {
          failures.push(`${candidate.host}: session broke during the renewal check`);
          continue;
        }
      }
    } catch (err) {
      log.debug('Renewal check errored', (err as Error).message);
    }
    log.info(`Signed in as ${displayName(user)} on ${baseUrl} (from ${candidate.profile.label})`);

    return {
      user,
      baseUrl,
      profile: candidate.profile,
      refreshed,
      canAutoRefresh,
      idpHosts: session.idpHosts,
    };
  }

  throw new BlackboardError('NOT_AUTHENTICATED', 'Found Blackboard cookies but none produced a working session.', {
    hint: `Tried:\n  ${failures.join('\n  ')}\n\nOpen Blackboard in your browser, confirm you are signed in, then retry. Or use \`blackboard-mcp auth login --paste\`.`,
  });
}

/** Returns the user when the session works, or null when it does not. */
async function probe(session: Session, config: Config): Promise<BbUser | null> {
  try {
    const http = new HttpClient(session, config);
    return await http.json<BbUser>({
      path: expand('self'),
      query: { expand: 'systemRoles,insRoles' },
      retries: 0,
    });
  } catch (err) {
    log.debug('Session probe failed', (err as Error).message);
    return null;
  }
}

export interface LoginOptions {
  /** Instance origin. Prompted for when absent and not already configured. */
  url?: string;
  /** Pre-supplied cookie/cURL text, for non-interactive use. */
  cookie?: string;
  /** Skip opening a browser during the paste flow. */
  noBrowser?: boolean;
  /** Force the manual paste flow instead of importing from a browser. */
  paste?: boolean;
  /** Restrict browser import to profiles whose label contains this. */
  profile?: string;
}

/**
 * Captures and validates a Blackboard session.
 *
 * Blackboard SaaS tenants almost always sit behind institutional SSO (SAML to
 * Azure AD, Shibboleth, ADFS), which cannot be scripted reliably or safely -
 * it involves the user's real credentials and usually MFA. So the browser does
 * the authentication and we import the resulting session, rather than ever
 * handling a password.
 */
export async function login(
  opts: LoginOptions = {},
): Promise<{ user: BbUser; baseUrl: string; source: 'browser' | 'paste'; refreshed?: boolean; canAutoRefresh?: boolean }> {
  // Importing from the browser asks the user nothing and is the only path that
  // captures the identity-provider cookies needed for silent refresh, so it is
  // tried first unless the caller explicitly wants the manual flow.
  if (!opts.paste && !opts.cookie && !process.env.BLACKBOARD_COOKIE) {
    try {
      const r = await loginFromBrowser({ url: opts.url, profileHint: opts.profile });
      return {
        user: r.user,
        baseUrl: r.baseUrl,
        source: 'browser',
        refreshed: r.refreshed,
        canAutoRefresh: r.canAutoRefresh,
      };
    } catch (err) {
      const be = err instanceof BlackboardError ? err : undefined;
      log.warn(`Browser import unavailable: ${be?.message ?? String(err)}`);
      process.stderr.write(
        `\nCould not import a session from your browser:\n  ${be?.message ?? String(err)}\n${
          be?.hint ? `  ${be.hint}\n` : ''
        }\nFalling back to manual sign-in.\n`,
      );
    }
  }

  const existing = loadConfigOrNull();
  let baseUrl = opts.url ? normaliseBaseUrl(opts.url) : existing?.baseUrl;

  // A cookie supplied up front may itself reveal the instance.
  if (opts.cookie && !baseUrl) baseUrl = parseBaseUrl(opts.cookie);

  if (!baseUrl && !opts.cookie) {
    const answer = await ask(
      'Blackboard URL (e.g. https://blackboard.your-university.edu): ',
    );
    if (!answer.trim()) {
      throw new BlackboardError('BAD_INPUT', 'No Blackboard URL given.', {
        hint: 'Re-run with --url https://blackboard.your-university.edu',
      });
    }
    baseUrl = normaliseBaseUrl(answer);
  }

  let pasted = opts.cookie ?? process.env.BLACKBOARD_COOKIE ?? '';

  if (!pasted) {
    const loginUrl = `${baseUrl}/ultra`;
    if (!opts.noBrowser) {
      const opened = await openBrowser(loginUrl);
      process.stderr.write(
        opened
          ? `\nOpened ${loginUrl} in your browser.\n`
          : `\nOpen this in your browser: ${loginUrl}\n`,
      );
    } else {
      process.stderr.write(`\nOpen this in your browser: ${loginUrl}\n`);
    }

    process.stderr.write(
      [
        '',
        'Sign in normally (including any SSO and MFA steps). Then:',
        '',
        '  1. Open DevTools (F12 or Cmd-Opt-I) and select the Network tab',
        '  2. Reload the page',
        `  3. Click any request to ${baseUrl ? new URL(baseUrl).hostname : 'your Blackboard host'}`,
        '  4. Right-click it > Copy > Copy as cURL',
        '',
        'Paste it below, then press Enter twice.',
        '',
        "(Blackboard's session cookie is HttpOnly, so copying from the console",
        ' with document.cookie will not work. It has to come from a request.)',
        '',
      ].join('\n'),
    );

    pasted = await askMultiline('> ');
  }

  const cookieHeader = parseCookieInput(pasted);
  const userAgent = parseUserAgent(pasted) ?? DEFAULT_USER_AGENT;
  baseUrl ??= parseBaseUrl(pasted);

  if (!baseUrl) {
    throw new BlackboardError('BAD_INPUT', 'Could not determine your Blackboard URL.', {
      hint: 'Re-run with --url https://blackboard.your-university.edu',
    });
  }

  const session = await Session.fromCookieHeader(baseUrl, cookieHeader, { userAgent });

  // Validate against the live instance before persisting: storing a session
  // that does not work just moves the failure to the first tool call.
  const config = saveConfig({ ...(existing ?? {}), baseUrl });
  const http = new HttpClient(session, config);
  let user: BbUser;
  try {
    user = await http.json<BbUser>({
      path: expand('self'),
      query: { expand: 'systemRoles,insRoles' },
      retries: 0,
    });
  } catch (err) {
    const be = err instanceof BlackboardError ? err : undefined;
    throw new BlackboardError(
      'NOT_AUTHENTICATED',
      `The captured session was rejected by ${new URL(baseUrl).hostname}.`,
      {
        hint: [
          'Check that you copied a request made while signed in, from the Blackboard host itself',
          '(not from an SSO provider like login.microsoftonline.com), and that the tab was still',
          'logged in when you copied it.',
          be?.message ? `\nUnderlying error: ${be.message}` : '',
        ].join(' '),
        cause: err,
      },
    );
  }

  session.user = { id: user.id, userName: user.userName, displayName: displayName(user) };
  await session.persist();
  log.info(`Signed in as ${displayName(user)} on ${baseUrl}`);

  return { user, baseUrl, source: 'paste', canAutoRefresh: false };
}
