import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync, readFileSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

const run = promisify(execFile);

/**
 * Reads session cookies straight out of the user's installed browser.
 *
 * This exists because the alternative ("open DevTools, copy as cURL") asks a
 * student to understand HTTP. It is also *required* for silent session refresh:
 * re-minting a Blackboard session needs the identity provider's cookies
 * (login.microsoftonline.com and friends), which a single copied Blackboard
 * request can never contain.
 *
 * Nothing here is exotic: it is the documented Chromium cookie store format,
 * read locally, decrypted with a key the OS already gives this user.
 */

export interface BrowserCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix ms, or 0 for a session cookie. */
  expires: number;
}

export interface BrowserProfile {
  browser: string;
  /** Human label, e.g. "Chrome: Profile 1". */
  label: string;
  /** Path to the cookie database. */
  cookieDb: string;
  /** Chromium only: the Local State file holding the wrapped encryption key. */
  localState?: string;
  family: 'chromium' | 'firefox';
  /** Last-modified time of the cookie DB, for "most recently used" ordering. */
  mtime: number;
}

const isMac = platform() === 'darwin';
const isWin = platform() === 'win32';

function appData(...p: string[]): string {
  if (isWin) return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), ...p);
  if (isMac) return join(homedir(), 'Library', 'Application Support', ...p);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), ...p);
}

function roaming(...p: string[]): string {
  if (isWin) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), ...p);
  if (isMac) return join(homedir(), 'Library', 'Application Support', ...p);
  return join(homedir(), ...p);
}

/** Chromium-family browsers and where they keep their user data. */
const CHROMIUM_ROOTS: Array<{ browser: string; root: string; keychain: [string, string] }> = [
  { browser: 'Chrome', root: appData(isMac ? 'Google/Chrome' : isWin ? 'Google/Chrome/User Data' : 'google-chrome'), keychain: ['Chrome Safe Storage', 'Chrome'] },
  { browser: 'Edge', root: appData(isMac ? 'Microsoft Edge' : isWin ? 'Microsoft/Edge/User Data' : 'microsoft-edge'), keychain: ['Microsoft Edge Safe Storage', 'Microsoft Edge'] },
  { browser: 'Brave', root: appData(isMac ? 'BraveSoftware/Brave-Browser' : isWin ? 'BraveSoftware/Brave-Browser/User Data' : 'BraveSoftware/Brave-Browser'), keychain: ['Brave Safe Storage', 'Brave'] },
  { browser: 'Chromium', root: appData(isMac ? 'Chromium' : isWin ? 'Chromium/User Data' : 'chromium'), keychain: ['Chromium Safe Storage', 'Chromium'] },
  { browser: 'Vivaldi', root: appData(isMac ? 'Vivaldi' : isWin ? 'Vivaldi/User Data' : 'vivaldi'), keychain: ['Vivaldi Safe Storage', 'Vivaldi'] },
  { browser: 'Opera', root: appData(isMac ? 'com.operasoftware.Opera' : isWin ? 'Programs/Opera' : 'opera'), keychain: ['Opera Safe Storage', 'Opera'] },
];

const FIREFOX_ROOTS = [
  roaming(isMac ? 'Firefox/Profiles' : isWin ? 'Mozilla/Firefox/Profiles' : '.mozilla/firefox'),
];

/** Enumerates every browser profile with a readable cookie store. */
export function discoverProfiles(): BrowserProfile[] {
  const found: BrowserProfile[] = [];

  for (const { browser, root } of CHROMIUM_ROOTS) {
    if (!existsSync(root)) continue;
    const localState = join(root, 'Local State');

    // Chromium keeps cookies per profile directory; "Default" plus "Profile N".
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const dir of dirs) {
      // Chrome 96+ moved cookies under Network/; older versions keep them flat.
      for (const rel of [join(dir, 'Network', 'Cookies'), join(dir, 'Cookies')]) {
        const db = join(root, rel);
        if (!existsSync(db)) continue;
        found.push({
          browser,
          label: `${browser} (${dir})`,
          cookieDb: db,
          localState: existsSync(localState) ? localState : undefined,
          family: 'chromium',
          mtime: safeMtime(db),
        });
        break;
      }
    }
  }

  for (const root of FIREFOX_ROOTS) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const db = join(root, dir, 'cookies.sqlite');
      if (!existsSync(db)) continue;
      found.push({
        browser: 'Firefox',
        label: `Firefox: ${dir.replace(/^[a-z0-9]+\./i, '')}`,
        cookieDb: db,
        family: 'firefox',
        mtime: safeMtime(db),
      });
    }
  }

  // Most recently used first: that is almost certainly where the user is signed in.
  return found.sort((a, b) => b.mtime - a.mtime);
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Opens a cookie database.
 *
 * The file is copied first: browsers hold a write lock and may have pages in
 * the WAL, so reading in place either fails or returns stale rows.
 */
async function queryCookieDb(
  profile: BrowserProfile,
  hosts: string[],
  opts: { byName?: string[] } = {},
): Promise<Array<Record<string, unknown>>> {
  const { DatabaseSync } = await importSqlite();

  const tmp = join(tmpdir(), `bbmcp-cookies-${process.pid}-${Date.now()}.sqlite`);
  try {
    copyFileSync(profile.cookieDb, tmp);
    // Copy the write-ahead log too, or recent logins may be invisible.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(profile.cookieDb + suffix)) {
        try {
          copyFileSync(profile.cookieDb + suffix, tmp + suffix);
        } catch {
          /* best effort */
        }
      }
    }

    const db = new DatabaseSync(tmp, { readOnly: false });
    try {
      const byName = opts.byName;
      // Match on a dot boundary. A bare `LIKE '%example.edu'` would also match
      // `evilexample.edu`, handing that domain's cookies to the importer.
      const like = byName
        ? byName.map(() => 'name = ?').join(' OR ')
        : hosts.map(() => '(host_key = ? OR host_key = ? OR host_key LIKE ?)').join(' OR ');
      const params = byName ?? hosts.flatMap((h) => [h, `.${h}`, `%.${h}`]);
      if (profile.family === 'firefox') {
        const clause = byName
          ? byName.map(() => 'name = ?').join(' OR ')
          : hosts.map(() => '(host = ? OR host = ? OR host LIKE ?)').join(' OR ');
        const stmt = db.prepare(
          `SELECT host, name, value, path, isSecure, isHttpOnly, expiry FROM moz_cookies WHERE ${clause}`,
        );
        return stmt.all(...params) as Array<Record<string, unknown>>;
      }
      // expires_utc is microseconds since 1601 and overflows a JS safe integer,
      // which node:sqlite refuses to coerce. Read it as text and parse.
      const stmt = db.prepare(
        `SELECT host_key, name, encrypted_value, value, path, is_secure, is_httponly,
                CAST(expires_utc AS TEXT) AS expires_utc
         FROM cookies WHERE ${like}`,
      );
      return stmt.all(...params) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(tmp + suffix, { force: true });
  }
}

async function importSqlite(): Promise<{ DatabaseSync: new (p: string, o?: unknown) => SqliteDb }> {
  try {
    // node:sqlite ships with Node 22.5+; there is no third-party fallback that
    // avoids a native build step, which would break `npx` installs.
    return (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string, o?: unknown) => SqliteDb;
    };
  } catch (cause) {
    throw new BlackboardError('UNSUPPORTED', 'Reading browser cookies needs Node 22.5 or newer.', {
      hint: `You are on ${process.version}. Upgrade Node, or sign in with \`blackboard-mcp auth login --paste\` instead.`,
      cause,
    });
  }
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

// ── Chromium value decryption ─────────────────────────────────────────────

/**
 * Chromium encrypts cookie values with a key held by the OS credential store.
 * The scheme differs per platform but is stable and documented:
 *
 *   macOS  PBKDF2(keychain password, "saltysalt", 1003) -> AES-128-CBC
 *   Linux  PBKDF2(keyring password or "peanuts", "saltysalt", 1) -> AES-128-CBC
 *   Windows  DPAPI-unwrapped key from Local State -> AES-256-GCM
 */
async function chromiumKey(profile: BrowserProfile): Promise<{ v10?: Buffer; gcm?: Buffer }> {
  if (isWin) {
    if (!profile.localState) {
      throw new BlackboardError('UNSUPPORTED', 'Could not find the browser Local State file.');
    }
    const state = JSON.parse(readFileSync(profile.localState, 'utf8')) as {
      os_crypt?: { encrypted_key?: string };
    };
    const wrapped = state.os_crypt?.encrypted_key;
    if (!wrapped) throw new BlackboardError('UNSUPPORTED', 'No encryption key in Local State.');
    const blob = Buffer.from(wrapped, 'base64').subarray(5); // strip "DPAPI"
    const gcm = await dpapiUnprotect(blob);
    return { gcm };
  }

  const entry = CHROMIUM_ROOTS.find((c) => c.browser === profile.browser)?.keychain;
  let password: string;

  if (isMac) {
    const [service, account] = entry ?? ['Chrome Safe Storage', 'Chrome'];
    try {
      const { stdout } = await run('security', [
        'find-generic-password', '-w', '-s', service, '-a', account,
      ]);
      password = stdout.trim();
    } catch (cause) {
      throw new BlackboardError('FORBIDDEN', `macOS did not release the ${profile.browser} cookie key.`, {
        hint: 'A keychain prompt may have appeared. Approve it and retry. If you denied it, run `security find-generic-password -s "Chrome Safe Storage"` once to re-prompt, or use `blackboard-mcp auth login --paste`.',
        cause,
      });
    }
  } else {
    password = await linuxKeyringPassword(entry?.[0] ?? 'Chrome Safe Storage');
  }

  const iterations = isMac ? 1003 : 1;
  const v10 = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  return { v10 };
}

/**
 * KWallet folder that holds a Chromium-family browser's "Safe Storage" key.
 *
 * Brave keeps it under `Brave Keys`, Chrome and Chromium under `Chromium Keys`,
 * derived from the service name (`Brave Safe Storage` -> `Brave Keys`).
 */
export function kwalletFolder(service: string): string {
  return service.replace(/ Safe Storage$/, ' Keys');
}

async function linuxKeyringPassword(service: string): Promise<string> {
  for (const args of [
    ['lookup', 'application', 'chrome'],
    ['lookup', 'service', service],
  ]) {
    try {
      const { stdout } = await run('secret-tool', args);
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* try the next strategy */
    }
  }
  // KDE desktops keep the same key in KWallet instead of exposing it through
  // the Secret Service, so `secret-tool` finds nothing. Try KWallet directly.
  for (const f of [kwalletFolder(service), 'Passwords']) {
    try {
      const { stdout } = await run('kwallet-query', ['-r', service, '-f', f, 'kdewallet']);
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* try the next folder */
    }
  }
  // Chromium falls back to this literal when no keyring is available; it is
  // not a secret, it is the documented default.
  log.debug('No Linux keyring entry found; using the Chromium default password');
  return 'peanuts';
}

/** Unwraps a DPAPI blob by delegating to PowerShell, avoiding a native module. */
async function dpapiUnprotect(blob: Buffer): Promise<Buffer> {
  const script = `
    Add-Type -AssemblyName System.Security;
    $b = [Convert]::FromBase64String('${blob.toString('base64')}');
    $p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser');
    [Convert]::ToBase64String($p)
  `;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      maxBuffer: 1024 * 1024,
    });
    return Buffer.from(stdout.trim(), 'base64');
  } catch (cause) {
    throw new BlackboardError('UNSUPPORTED', 'Windows would not unwrap the browser encryption key.', {
      hint: 'Use `blackboard-mcp auth login --paste` instead.',
      cause,
    });
  }
}

function decryptValue(
  encrypted: Buffer,
  keys: { v10?: Buffer; gcm?: Buffer },
  plain: string | undefined,
): string {
  if (encrypted.length === 0) return plain ?? '';
  const prefix = encrypted.subarray(0, 3).toString('latin1');

  // Chrome 127+ on Windows wraps values with App-Bound Encryption, which is
  // deliberately not decryptable by another process. Detect and say so rather
  // than returning corrupt bytes.
  if (prefix === 'v20') {
    throw new BlackboardError('UNSUPPORTED', 'This browser uses App-Bound Encryption (Chrome 127+ on Windows).', {
      hint: 'Cookie import cannot work here by design. Use `blackboard-mcp auth login --browser` (drives a real browser) or `--paste`.',
    });
  }

  if (prefix === 'v10' || prefix === 'v11') {
    const body = encrypted.subarray(3);
    if (isWin) {
      if (!keys.gcm) throw new BlackboardError('INTERNAL', 'Missing AES-GCM key.');
      const nonce = body.subarray(0, 12);
      const tag = body.subarray(body.length - 16);
      const ct = body.subarray(12, body.length - 16);
      const d = createDecipheriv('aes-256-gcm', keys.gcm, nonce);
      d.setAuthTag(tag);
      return stripDomainHash(Buffer.concat([d.update(ct), d.final()])).toString('utf8');
    }
    if (!keys.v10) throw new BlackboardError('INTERNAL', 'Missing AES-CBC key.');
    const d = createDecipheriv('aes-128-cbc', keys.v10, Buffer.alloc(16, ' '));
    d.setAutoPadding(false);
    const out = Buffer.concat([d.update(body), d.final()]);
    return stripDomainHash(stripPkcs7(out)).toString('utf8');
  }

  // Unencrypted (old profiles, or Linux with no keyring at write time).
  return plain && plain.length > 0 ? plain : encrypted.toString('utf8');
}

function stripPkcs7(buf: Buffer): Buffer {
  const pad = buf[buf.length - 1] ?? 0;
  return pad > 0 && pad <= 16 ? buf.subarray(0, buf.length - pad) : buf;
}

/**
 * Recent Chromium prepends a 32-byte SHA-256 of the cookie's domain to the
 * plaintext. It is not part of the value, and leaving it in corrupts the cookie.
 * Detect it by looking for non-printable bytes at the front.
 */
function stripDomainHash(buf: Buffer): Buffer {
  if (buf.length <= 32) return buf;
  const head = buf.subarray(0, 32);
  let nonPrintable = 0;
  for (const b of head) if (b < 0x20 || b > 0x7e) nonPrintable += 1;
  return nonPrintable >= 8 ? buf.subarray(32) : buf;
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Reads cookies for the given hosts out of one browser profile.
 *
 * `hosts` are matched as domain suffixes, so passing
 * `['blackboard.example.edu', 'login.microsoftonline.com']` also picks up
 * `.microsoftonline.com`-scoped cookies, which is where the persistent
 * identity-provider session actually lives.
 */
export async function readBrowserCookies(
  profile: BrowserProfile,
  hosts: string[],
): Promise<BrowserCookie[]> {
  const rows = await queryCookieDb(profile, hosts);
  if (rows.length === 0) return [];

  if (profile.family === 'firefox') {
    return rows.map((r) => ({
      host: String(r.host ?? ''),
      name: String(r.name ?? ''),
      value: String(r.value ?? ''),
      path: String(r.path ?? '/'),
      secure: Boolean(r.isSecure),
      httpOnly: Boolean(r.isHttpOnly),
      expires: Number(r.expiry ?? 0) * 1000,
    }));
  }

  const keys = await chromiumKey(profile);
  const out: BrowserCookie[] = [];
  let failures = 0;

  for (const r of rows) {
    const enc = r.encrypted_value as Buffer | Uint8Array | null;
    try {
      const value = decryptValue(
        Buffer.isBuffer(enc) ? enc : Buffer.from(enc ?? []),
        keys,
        r.value as string | undefined,
      );
      if (!value) continue;
      out.push({
        host: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
        value,
        path: String(r.path ?? '/'),
        secure: Boolean(r.is_secure),
        httpOnly: Boolean(r.is_httponly),
        // Chromium stores microseconds since 1601-01-01.
        expires: chromeTimeToMs(Number(r.expires_utc ?? 0)),
      });
    } catch (err) {
      if (err instanceof BlackboardError && err.code === 'UNSUPPORTED') throw err;
      failures += 1;
    }
  }

  if (failures > 0) log.debug(`${failures} cookie value(s) could not be decrypted`);
  return out;
}

export function chromeTimeToMs(chromeTime: number): number {
  if (!chromeTime || !Number.isFinite(chromeTime)) return 0;
  // 11644473600 seconds between 1601-01-01 and 1970-01-01.
  return Math.round(chromeTime / 1000 - 11644473600000);
}

/** Renders cookies as a `Cookie:` header for one host. */
export function toCookieHeader(cookies: BrowserCookie[], host: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of cookies) {
    const domain = c.host.replace(/^\./, '');
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

/**
 * Finds Blackboard instances the user is signed in to, by looking for
 * Blackboard's own signature cookie in each browser profile.
 *
 * `BbRouter` is emitted only by Blackboard Learn, so its presence identifies
 * both *that* the user has a session and *which host* it belongs to. This is
 * what lets `auth login` work with no questions asked.
 */
export async function discoverInstances(
  profiles: BrowserProfile[],
): Promise<Array<{ profile: BrowserProfile; host: string; hasBbRouter: boolean }>> {
  const out: Array<{ profile: BrowserProfile; host: string; hasBbRouter: boolean }> = [];

  for (const profile of profiles) {
    try {
      const rows = await queryCookieDb(profile, [], { byName: ['BbRouter', 'JSESSIONID'] });
      const hosts = new Map<string, boolean>();
      for (const r of rows) {
        const host = String(r.host_key ?? r.host ?? '').replace(/^\./, '');
        if (!host) continue;
        const isBbRouter = String(r.name) === 'BbRouter';
        // JSESSIONID alone is any Java app; require a Blackboard-looking host.
        if (!isBbRouter && !/blackboard|learn|bb\./i.test(host)) continue;
        // Blackboard's own file, CDN and developer hosts also set BbRouter but
        // serve no LMS API, so they must not be mistaken for the instance.
        if (isInfrastructureHost(host)) continue;
        hosts.set(host, (hosts.get(host) ?? false) || isBbRouter);
      }
      for (const [host, hasBbRouter] of hosts) out.push({ profile, host, hasBbRouter });
    } catch (err) {
      log.debug(`Could not scan ${profile.label}`, String(err));
    }
  }

  // Strongest evidence first: a real BbRouter beats a bare JSESSIONID, and a
  // recently-used profile beats a stale one.
  return out.sort(
    (a, b) => Number(b.hasBbRouter) - Number(a.hasBbRouter) || b.profile.mtime - a.profile.mtime,
  );
}

/** Hosts worth pulling alongside Blackboard, so silent refresh can work. */
export const IDP_COOKIE_HOSTS = [
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
  'sts.windows.net',
  'accounts.google.com',
  'okta.com',
  'onelogin.com',
  'auth0.com',
  'shibboleth.net',
  'blackboard.com',
];

/**
 * Blackboard operates several auxiliary hosts that carry the same cookies as the LMS
 * but expose no course API: the `alt-*` file mirror, Xythos storage, the
 * document viewer, notification sockets, and the developer portal.
 */
export function isInfrastructureHost(host: string): boolean {
  return (
    /^alt-[0-9a-f]+\.blackboard\.com$/i.test(host) ||
    /xythos|bbcdn|cloudfront|basic-doc-viewer|notif-websockets|collab|telemetry/i.test(host) ||
    host === 'developer.blackboard.com' ||
    host === 'developer.anthology.com'
  );
}
