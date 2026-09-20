import { CookieJar } from 'tough-cookie';
import { Session, extractXsrf } from './session.js';
import { BlackboardError } from '../lib/errors.js';
import { log, redact } from '../lib/logger.js';

/**
 * Silent session renewal by replaying the institution's SSO redirect chain.
 *
 * Blackboard sessions last a few hours; the identity provider's session lasts
 * weeks (Azure AD's `ESTSAUTHPERSISTENT`, Shibboleth's `_shibsession_`). So a
 * lapsed Blackboard session can be re-minted with no user interaction at all,
 * provided we still hold the IdP's cookies: which is exactly what a browser
 * does when you reload the page after being logged out.
 *
 * Verified against a HAR capture of a real reload on an Azure AD tenant:
 *
 *   GET  /                                         -> 302 /auth-saml/saml/login
 *   GET  /auth-saml/saml/login?apId=..&redirectUrl -> 302 IdP?SAMLRequest=..
 *   GET  IdP?SAMLRequest=..                        -> 200 (JS bootstrap page)
 *   GET  IdP?SAMLRequest=..&sso_reload=true        -> 200 auto-submit form
 *   POST /auth-saml/saml/SSO  (SAMLResponse=..)    -> 302 /ultra  [new BbRouter]
 *
 * The implementation is deliberately generic. Follow redirects, auto-submit
 * any form the IdP hands back, stop when Blackboard gives us a session cookie.
 * That covers SAML, WS-Federation and Shibboleth without special-casing any
 * single provider.
 */

const MAX_HOPS = 40;

/** Cookies whose presence means Blackboard considers us signed in. */
const SESSION_COOKIES = ['BbRouter', 'JSESSIONID'];

export interface RefreshResult {
  ok: boolean;
  /** Hops walked, for diagnostics. */
  hops: string[];
  /** Hosts the chain touched, so they can be pinned for next time. */
  hostsSeen: string[];
  /** Set when the IdP demanded interactive sign-in. */
  needsInteractiveLogin?: boolean;
  reason?: string;
}

/**
 * Attempts to renew `session` in place.
 *
 * On success the session's jar holds a fresh `BbRouter` and has been persisted.
 * On failure nothing is mutated destructively. The old cookies remain, since
 * a stale session is still better than none while the user decides what to do.
 */
export async function refreshSession(
  session: Session,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  const baseHost = new URL(session.baseUrl).hostname;
  const hops: string[] = [];
  const hostsSeen = new Set<string>([baseHost]);

  // Work on a copy so a failed refresh cannot corrupt a still-usable session.
  const jar = await cloneJar(session.jar);

  // `force` walks the full provider chain even when the current session would
  // still be accepted. A live session short-circuits at `GET /ultra -> 200`,
  // which proves nothing about whether renewal *would* work. So verifying the
  // capability means temporarily setting the session cookies aside.
  if (opts.force) await dropSessionCookies(jar, session.baseUrl);

  const before = await sessionCookieFingerprint(jar, session.baseUrl);

  let url = `${session.baseUrl}/ultra`;
  let method = 'GET';
  let body: URLSearchParams | undefined;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const target = new URL(url);
    hostsSeen.add(target.hostname);

    if (!isAllowedHost(target.hostname, baseHost, session.idpHosts)) {
      return fail(hops, hostsSeen, `refusing to send cookies to ${target.hostname}`);
    }

    const headers: Record<string, string> = {
      'User-Agent': session.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: await jar.getCookieString(url),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin = target.origin;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return fail(hops, hostsSeen, `network error at ${target.hostname}: ${(err as Error).message}`);
    }

    hops.push(`${method} ${target.hostname}${target.pathname} -> ${res.status}`);

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      await jar.setCookie(raw, url, { ignoreError: true });
    }

    // ── redirect ──
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return fail(hops, hostsSeen, `redirect with no Location at ${target.pathname}`);
      url = new URL(loc, url).toString();
      method = 'GET';
      body = undefined;
      continue;
    }

    if (!res.ok) {
      return fail(hops, hostsSeen, `HTTP ${res.status} at ${target.hostname}${target.pathname}`);
    }

    const html = await res.text();

    // ── did the IdP demand a real sign-in? ──
    if (needsInteractiveLogin(html, target.hostname, baseHost)) {
      return {
        ok: false,
        hops,
        hostsSeen: [...hostsSeen],
        needsInteractiveLogin: true,
        reason: `${target.hostname} is asking for credentials; the identity-provider session has expired`,
      };
    }

    // ── an auto-submitting form is the SSO handoff; replay it ──
    const form = parseAutoSubmitForm(html, url);
    if (form) {
      log.debug(`SSO handoff: POST ${form.action}`, { fields: [...form.fields.keys()] });
      url = form.action;
      method = form.method;
      body = new URLSearchParams([...form.fields.entries()]);
      continue;
    }

    // ── Azure AD's bootstrap page needs a nudge to attempt silent SSO ──
    if (!target.searchParams.has('sso_reload') && looksLikeIdpBootstrap(html, target.hostname, baseHost)) {
      target.searchParams.set('sso_reload', 'true');
      url = target.toString();
      method = 'GET';
      body = undefined;
      continue;
    }

    // ── back on Blackboard with a new session? ──
    if (target.hostname === baseHost) {
      const after = await sessionCookieFingerprint(jar, session.baseUrl);
      if (after && after !== before) {
        // The chain has now named the tenant's actual identity provider, so
        // every other host's cookies were speculative and can go. Login has to
        // import broadly (the IdP is unknowable up front), but keeping
        // unrelated cookies (Google, Auth0, whatever else matched) would be
        // indefensible once we know which one is real.
        await pruneToHosts(jar, [baseHost, ...hostsSeen]);
        session.jar = jar;
        session.xsrfToken = await extractXsrf(jar, session.baseUrl);
        session.capturedAt = new Date();
        // When the chain actually visited the provider, it is authoritative
        // about which one this tenant uses, so narrow the allowlist to that.
        // But a still-valid session short-circuits at `GET /ultra -> 200`
        // without ever leaving Blackboard, and treating that as "no provider"
        // would destroy the very capability we are trying to preserve.
        const external = [...hostsSeen].filter((h) => h !== baseHost);
        if (external.length > 0) session.idpHosts = external;
        await session.persist();
        log.info('Session refreshed silently', {
          hops: hops.length,
          xsrf: session.xsrfToken ? redact(session.xsrfToken) : null,
        });
        return { ok: true, hops, hostsSeen: [...hostsSeen] };
      }
      return fail(
        hops,
        hostsSeen,
        after
          ? 'landed back on Blackboard but the session cookie did not change'
          : 'landed back on Blackboard with no session cookie',
      );
    }

    return fail(hops, hostsSeen, `stalled on ${target.hostname} with no form to submit`);
  }

  return fail(hops, hostsSeen, `exceeded ${MAX_HOPS} redirects`);
}

function fail(hops: string[], hostsSeen: Set<string>, reason: string): RefreshResult {
  log.debug(`Silent refresh failed: ${reason}`);
  return { ok: false, hops, hostsSeen: [...hostsSeen], reason };
}

/**
 * Only the Blackboard host and hosts previously seen in *Blackboard's own*
 * redirect chain may receive cookies.
 *
 * The first hop of a refresh is always Blackboard, and it is Blackboard that
 * names its identity provider, so trust is delegated rather than assumed. A
 * short allowlist of well-known federation hosts covers a first refresh before
 * any IdP host has been pinned.
 */
function isAllowedHost(host: string, baseHost: string, pinned: string[] | undefined): boolean {
  if (host === baseHost) return true;
  if (pinned?.includes(host)) return true;
  return KNOWN_IDP_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Federation endpoints institutions actually use. */
const KNOWN_IDP_SUFFIXES = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'sts.windows.net',
  'login.windows.net',
  'accounts.google.com',
  'okta.com',
  'oktapreview.com',
  'onelogin.com',
  'auth0.com',
  'shibboleth.net',
  'blackboard.com',
  'anthology.com',
];

interface ParsedForm {
  action: string;
  method: 'POST' | 'GET';
  fields: Map<string, string>;
}

/**
 * Finds a form the page submits by itself.
 *
 * SSO handoffs are always shaped this way: a form of hidden fields plus an
 * onload submit. We require a recognisable SSO field so an ordinary login form
 * is never mistaken for a handoff and blind-submitted.
 */
export function parseAutoSubmitForm(html: string, baseUrl: string): ParsedForm | null {
  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return null;
  const [, attrs = '', inner = ''] = formMatch;

  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
  if (!action) return null;

  const method = (/\bmethod\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? 'POST').toUpperCase();

  const fields = new Map<string, string>();
  const inputRe = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(inner)) !== null) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const rawValue = /\bvalue\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1] ?? '';
    fields.set(name, decodeHtmlAttr(rawValue));
  }

  // The SSO payload field must be present. Submitting an arbitrary form could
  // otherwise post credentials or trigger an unintended action.
  const SSO_FIELDS = ['SAMLResponse', 'SAMLRequest', 'wresult', 'wa', 'id_token', 'code'];
  if (!SSO_FIELDS.some((f) => fields.has(f))) return null;

  const autoSubmits =
    /document\.forms\s*\[\s*0\s*\]\s*\.submit|\.submit\(\)|onload\s*=/i.test(html);
  if (!autoSubmits) return null;

  return {
    action: new URL(decodeHtmlAttr(action), baseUrl).toString(),
    method: method === 'GET' ? 'GET' : 'POST',
    fields,
  };
}

function decodeHtmlAttr(v: string): string {
  return (
    v
      // Numeric entities first: decoding `&amp;` before them would turn
      // `&amp;#x2f;` into `/` instead of the literal `&#x2f;`.
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
        const code = parseInt(h, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#(\d+);/g, (_, d: string) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

/** Azure AD serves a JS bootstrap page that retries itself with `sso_reload`. */
function looksLikeIdpBootstrap(html: string, host: string, baseHost: string): boolean {
  if (host === baseHost) return false;
  return /\$Config\s*=|urlPostMs|ConvergedSignIn|sso_reload/i.test(html);
}

/**
 * Detects a page asking a human for credentials.
 *
 * A username or password field on the IdP means the provider session is gone
 * and no amount of replaying will help. The user has to sign in again.
 */
function needsInteractiveLogin(html: string, host: string, baseHost: string): boolean {
  if (host === baseHost) {
    // Blackboard's own local login form.
    return /name=["'](user_id|password)["']/i.test(html);
  }
  return (
    /name=["'](loginfmt|passwd|username|password|j_username)["']/i.test(html) &&
    !/SAMLResponse|wresult/i.test(html)
  );
}

/** A stable fingerprint of the session cookies, to prove renewal happened. */
async function sessionCookieFingerprint(jar: CookieJar, url: string): Promise<string | null> {
  const cookies = await jar.getCookies(url);
  const parts = cookies
    .filter((c) => SESSION_COOKIES.includes(c.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((c) => `${c.key}=${c.value}`);
  return parts.length > 0 ? parts.join('|') : null;
}

async function cloneJar(jar: CookieJar): Promise<CookieJar> {
  return CookieJar.deserialize(await jar.serialize());
}

/**
 * Drops every cookie whose domain is not one of `hosts`.
 *
 * tough-cookie has no bulk delete, so the jar is rebuilt from its serialised
 * form. Cheap, and it keeps the store's own invariants intact.
 */
async function pruneToHosts(jar: CookieJar, hosts: string[]): Promise<void> {
  const keep = new Set(hosts.map((h) => h.toLowerCase()));
  const serialised = await jar.serialize();
  const before = serialised.cookies.length;

  const kept = serialised.cookies.filter((c) => {
    const domain = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!domain) return false;
    if (keep.has(domain)) return true;
    // Keep parent-domain cookies that the retained hosts would actually send.
    return [...keep].some((h) => h === domain || h.endsWith(`.${domain}`));
  });

  if (kept.length === before) return;

  const rebuilt = await CookieJar.deserialize({ ...serialised, cookies: kept });
  const dropped = before - kept.length;
  log.debug(`Pruned ${dropped} cookie(s) for hosts outside the SSO chain`);

  // Replace the caller's jar contents in place.
  const fresh = await rebuilt.serialize();
  const replacement = await CookieJar.deserialize(fresh);
  (jar as unknown as { store: unknown }).store = (
    replacement as unknown as { store: unknown }
  ).store;
}

/**
 * Removes Blackboard's session cookies from a jar, so the next request is
 * treated as unauthenticated and gets redirected into the SSO chain.
 */
async function dropSessionCookies(jar: CookieJar, baseUrl: string): Promise<void> {
  const host = new URL(baseUrl).hostname;
  const serialised = await jar.serialize();
  const kept = serialised.cookies.filter((c) => {
    const domain = String(c.domain ?? '').replace(/^\./, '');
    const isBlackboard = domain === host;
    return !(isBlackboard && [...SESSION_COOKIES, 'samlCookie'].includes(String(c.key)));
  });
  const rebuilt = await CookieJar.deserialize({ ...serialised, cookies: kept });
  (jar as unknown as { store: unknown }).store = (
    rebuilt as unknown as { store: unknown }
  ).store;
}

/**
 * Discovers which identity provider a Blackboard instance federates to, by
 * walking its login redirect **without any credentials**.
 *
 * An unauthenticated `GET /ultra` still 302s all the way to the provider's
 * sign-in page, and every hop names a host. That makes the provider knowable
 * before any cookie is read, which matters: the alternative is guessing, either
 * from a hardcoded list of well-known providers (which misses institutions
 * running their own SSO) or by sweeping a whole registrable domain (which
 * collects cookies for every unrelated service the institution hosts).
 *
 * Sends no cookies and reads no browser state, so it is safe to call before the
 * user has been asked for anything.
 */
export async function discoverIdpHosts(
  baseUrl: string,
  opts: { userAgent?: string; maxHops?: number } = {},
): Promise<{ hosts: string[]; hops: string[] }> {
  const baseHost = new URL(baseUrl).hostname;
  const hosts = new Set<string>();
  const hops: string[] = [];
  let url = `${baseUrl}/ultra`;

  for (let hop = 0; hop < (opts.maxHops ?? 10); hop += 1) {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      break;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        // No cookies, no credentials: this is a pure discovery probe.
        credentials: 'omit',
        headers: {
          'User-Agent': opts.userAgent ?? DEFAULT_PROBE_UA,
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.debug(`IdP probe stopped at ${target.hostname}`, (err as Error).message);
      break;
    }

    hops.push(`${target.hostname}${target.pathname} -> ${res.status}`);
    if (target.hostname !== baseHost) hosts.add(target.hostname);

    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get('location');
    if (!loc) break;
    url = new URL(loc, url).toString();
  }

  log.debug('Discovered identity provider hosts', [...hosts]);
  return { hosts: [...hosts], hops };
}

const DEFAULT_PROBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
