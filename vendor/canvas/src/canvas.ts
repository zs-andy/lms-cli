/**
 * Canvas LMS REST API client.
 *
 * Auth (either works; token wins if both are set):
 *  - CANVAS_API_TOKEN — personal access token (if your school allows generating one)
 *  - CANVAS_COOKIE    — the browser session Cookie header, for schools that disable
 *                       self-service tokens. Copy it from DevTools while logged in.
 *
 * Both may live in the macOS Keychain instead of the environment, which keeps the
 * credential out of the MCP client's plaintext config file. Environment variables
 * win when both are present. Set CANVAS_NO_KEYCHAIN=1 to skip Keychain entirely.
 *
 * Base URL: CANVAS_BASE_URL env var — your school's Canvas domain.
 */
import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = process.env.CANVAS_KEYCHAIN_SERVICE || "canvas-student-mcp";

export type CredentialSource = "environment variable" | "macOS Keychain" | "none";

type Credentials = {
  token?: string;
  cookie?: string;
  source: CredentialSource;
};

let cached: Credentials | null = null;

/** Read one secret from the macOS Keychain; undefined when absent or unavailable. */
function keychainGet(account: string): string | undefined {
  if (process.platform !== "darwin" || process.env.CANVAS_NO_KEYCHAIN) return undefined;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return value || undefined;
  } catch {
    // Not found, locked, or `security` unavailable — fall through to env vars.
    return undefined;
  }
}

/** Resolve credentials once per process: environment first, then Keychain. */
export function credentials(): Credentials {
  if (cached) return cached;

  const envToken = process.env.CANVAS_API_TOKEN;
  const envCookie = process.env.CANVAS_COOKIE;
  if (envToken || envCookie) {
    cached = { token: envToken, cookie: envCookie, source: "environment variable" };
    return cached;
  }

  const kcToken = keychainGet("token");
  const kcCookie = keychainGet("cookie");
  cached = kcToken || kcCookie
    ? { token: kcToken, cookie: kcCookie, source: "macOS Keychain" }
    : { source: "none" };
  return cached;
}

export function baseUrl(): string {
  const url = process.env.CANVAS_BASE_URL;
  if (!url) {
    throw new Error(
      "CANVAS_BASE_URL is not set. Set it to your school's Canvas URL " +
        "(e.g. https://unt.instructure.com) in this MCP server's env config."
    );
  }
  return url.replace(/\/+$/, "");
}

export type QueryParams = Record<
  string,
  string | number | boolean | Array<string | number> | undefined
>;

export function usingCookieAuth(): boolean {
  const c = credentials();
  return !c.token && !!c.cookie;
}

function authHeaders(): Record<string, string> {
  const c = credentials();
  const agent: Record<string, string> = process.env.CANVAS_USER_AGENT ? { 'User-Agent': process.env.CANVAS_USER_AGENT } : {};
  if (c.token) return { ...agent, Authorization: `Bearer ${c.token}` };
  if (c.cookie) return { ...agent, Cookie: c.cookie };

  throw new Error(
    "No Canvas credentials configured. Set CANVAS_API_TOKEN (a personal access token), or — if your school " +
      `disables token generation — set CANVAS_COOKIE: log into ${baseUrl()} in your browser, open DevTools → ` +
      "Network tab, refresh, click any request to the Canvas domain, and copy the full 'cookie:' request header value. " +
      "On macOS you can store it in the Keychain instead of the config file: " +
      `security add-generic-password -s ${KEYCHAIN_SERVICE} -a cookie -w '<value>' -U`
  );
}

function buildUrl(path: string, params?: QueryParams): URL {
  const url = new URL(`${baseUrl()}/api/v1${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url;
}

async function fetchJson(url: URL): Promise<{ data: unknown; nextUrl: string | null }> {
  // Local deployment guard: pagination must never forward credentials off-origin.
  const origin = new URL(baseUrl());
  if (url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password) {
    throw new Error("Refusing a Canvas API URL outside the configured HTTPS origin");
  }
  const res = await fetch(url, {
    headers: {
      ...authHeaders(),
      Accept: "application/json",
    },
    redirect: "manual", // cookie-auth failures redirect to the login page instead of returning 401
    signal: AbortSignal.timeout(30_000),
  });

  // With cookie auth, an expired session often redirects (302) to /login rather than 401ing.
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `Canvas redirected the request — your session cookie has expired. Log into ${baseUrl()} in your browser ` +
        "again, re-copy the 'cookie:' header from DevTools (Network tab), and update CANVAS_COOKIE in the MCP env config."
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      detail = body.slice(0, 500);
    } catch {
      /* ignore */
    }
    const authHint = usingCookieAuth()
      ? `Session cookie was rejected or expired. Log into ${baseUrl()} again and re-copy the 'cookie:' header from DevTools into CANVAS_COOKIE.`
      : `Token was rejected. It may have expired or been revoked — generate a new one at ${baseUrl()}/profile/settings and update the MCP env config.`;
    const hints: Record<number, string> = {
      401: authHint,
      403: "You don't have permission for this resource. It may be from a course you're not enrolled in, or the feature is disabled by the instructor.",
      404: "Not found. Check the ID — course/assignment IDs come from the list tools (e.g. canvas_list_courses).",
    };
    const hint = hints[res.status] ?? "";
    throw new Error(`Canvas API ${res.status} ${res.statusText} for ${url.pathname}. ${hint} ${detail}`.trim());
  }

  // Parse the Link header for pagination (rel="next").
  const link = res.headers.get("link") ?? "";
  let nextUrl: string | null = null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) {
      nextUrl = m[1]!;
      break;
    }
  }

  // Cookie-authenticated responses are prefixed with an XSSI guard: `while(1);{...}`
  const raw = await res.text();
  const clean = raw.replace(/^while\(1\);/, "");
  let data: unknown;
  try {
    data = JSON.parse(clean);
  } catch {
    throw new Error(
      `Canvas returned non-JSON for ${url.pathname} — this usually means the session cookie expired and Canvas ` +
        `served a login page. Log into ${baseUrl()} again and update CANVAS_COOKIE.`
    );
  }
  return { data, nextUrl };
}

/**
 * Download a file from a Canvas-issued URL.
 *
 * Token-authenticated sessions get a `verifier=` param that makes file URLs
 * self-authenticating; cookie-authenticated sessions do not, so the session
 * cookie has to ride along or Canvas answers 500. Redirects are followed by
 * hand: file URLs often bounce to a CDN, which must never receive credentials.
 */
export async function canvasDownload(fileUrl: string): Promise<Buffer> {
  const canvasOrigin = new URL(baseUrl()).origin;
  let url = fileUrl;

  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new Error("Refusing an insecure Canvas file download URL");
    }
    const sameHost = target.origin === canvasOrigin;
    const res = await fetch(url, {
      headers: sameHost ? authHeaders() : {},
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Canvas redirected (${res.status}) without a location header`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      throw new Error(`Download failed (${res.status} ${res.statusText}) for ${new URL(url).pathname}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("Too many redirects while downloading the file");
}

/** GET a single (non-paginated) resource. */
export async function canvasGet(path: string, params?: QueryParams): Promise<any> {
  const { data } = await fetchJson(buildUrl(path, params));
  return data;
}

/**
 * GET a paginated collection, following Link rel="next" headers.
 * Caps at maxPages to protect context; results note if truncated.
 */
export async function canvasGetPaginated(
  path: string,
  params?: QueryParams,
  maxPages = 5
): Promise<{ items: any[]; truncated: boolean }> {
  const items: any[] = [];
  let url: URL | null = buildUrl(path, { per_page: 100, ...params });
  let pages = 0;
  let truncated = false;

  while (url) {
    const { data, nextUrl } = await fetchJson(url);
    if (Array.isArray(data)) items.push(...data);
    pages++;
    if (nextUrl && pages >= maxPages) {
      truncated = true;
      break;
    }
    url = nextUrl ? new URL(nextUrl) : null;
  }

  return { items, truncated };
}
