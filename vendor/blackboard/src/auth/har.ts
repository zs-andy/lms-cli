import { readFileSync, statSync } from 'node:fs';
import { Session, DEFAULT_USER_AGENT } from './session.js';
import { saveConfig, normaliseBaseUrl } from '../config.js';
import {
  DEFAULT_ENDPOINTS, saveProfile, type EndpointMap, type EndpointProfile, type OperationName,
} from '../client/endpoints.js';
import { BlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { fmtBytes } from '../lib/files.js';

interface HarEntry {
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    cookies?: Array<{ name: string; value: string }>;
  };
  response?: { status?: number; content?: { mimeType?: string } };
}

interface Har {
  log?: { entries?: HarEntry[] };
}

export interface HarImportResult {
  baseUrl: string;
  entries: number;
  apiEntries: number;
  /** Operations whose path template was corrected from the recording. */
  overrides: Array<{ operation: string; from: string; to: string }>;
  /** Known operations the recording confirmed as-is. */
  confirmed: string[];
  /** Known operations the recording never exercised. */
  unseen: string[];
  /** API paths in the recording that map to no known operation. */
  unmapped: Array<{ method: string; path: string; count: number }>;
  /** True when the HAR still contained cookies and a session was stored. */
  sessionCaptured: boolean;
  userAgent?: string;
}

/** Replaces concrete ids with placeholders so paths can be compared by shape. */
export function normalisePath(path: string): string {
  return path
    .replace(/\/_\d+_\d+/g, '/{id}')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
    .replace(/\/[0-9a-f]{32}/gi, '/{id}')
    .replace(/\/\d{4,}/g, '/{id}');
}

/** Turns an endpoint template into a regex matching its normalised shape. */
function templateShape(template: string): string {
  return template.replace(/\{\w+\}/g, '{id}');
}

/**
 * Imports a browser HAR recording.
 *
 * Two things are extracted:
 *
 *   1. **Endpoint corrections.** Learn releases and reverse proxies move paths
 *      around (a course detail read is `public/v1` on one tenant and `v3` on
 *      another; some tenants front everything with a path prefix). Comparing
 *      the recording's real paths against the built-in templates produces an
 *      override profile, so the package adapts to a tenant without a code change.
 *
 *   2. **A session, if the HAR still has one.** Current Chrome strips `Cookie`
 *      and `Set-Cookie` from HAR exports, so this usually finds nothing. Which
 *      is a good default, since a HAR with cookies is a credential file. Firefox
 *      and some proxy tools do include them.
 */
export async function importHar(
  file: string,
  opts: { url?: string; captureSession?: boolean } = {},
): Promise<HarImportResult> {
  const size = statSync(file).size;
  log.info(`Reading HAR (${fmtBytes(size)})`);
  if (size > 400 * 1024 * 1024) {
    throw new BlackboardError('BAD_INPUT', `HAR is ${fmtBytes(size)}, too large to parse safely.`, {
      hint: 'Re-record a shorter session, or filter the HAR to your Blackboard host first.',
    });
  }

  let har: Har;
  try {
    har = JSON.parse(readFileSync(file, 'utf8')) as Har;
  } catch (cause) {
    throw new BlackboardError('BAD_INPUT', `Could not parse ${file} as HAR JSON.`, { cause });
  }

  const entries = har.log?.entries ?? [];
  if (entries.length === 0) {
    throw new BlackboardError('BAD_INPUT', 'The HAR contains no entries.');
  }

  // ── which host is the Blackboard instance? ──
  // The one serving the most /learn/api traffic, which is unambiguous even when
  // the recording also captured CDNs, analytics and LTI tools.
  const apiHostCounts = new Map<string, number>();
  for (const e of entries) {
    const url = e.request?.url;
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.pathname.startsWith('/learn/api/')) {
        apiHostCounts.set(u.host, (apiHostCounts.get(u.host) ?? 0) + 1);
      }
    } catch {
      /* skip malformed URLs */
    }
  }

  const detected = [...apiHostCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const baseUrl = opts.url
    ? normaliseBaseUrl(opts.url)
    : detected
      ? normaliseBaseUrl(detected)
      : undefined;

  if (!baseUrl) {
    throw new BlackboardError('BAD_INPUT', 'No Blackboard API traffic found in the HAR.', {
      hint: 'Record while browsing the Blackboard Ultra interface, or pass --url explicitly.',
    });
  }

  const host = new URL(baseUrl).host;

  // ── collect the API surface actually used ──
  const observed = new Map<string, { method: string; path: string; count: number }>();
  let apiEntries = 0;
  let userAgent: string | undefined;

  for (const e of entries) {
    const url = e.request?.url;
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== host) continue;

    if (!userAgent) {
      userAgent = e.request?.headers?.find((h) => h.name.toLowerCase() === 'user-agent')?.value;
    }

    // Only successful JSON API reads are evidence of a working endpoint.
    const status = e.response?.status ?? 0;
    if (!u.pathname.startsWith('/learn/api/') && !u.pathname.startsWith('/institution/api/')) continue;
    apiEntries += 1;
    if (status < 200 || status >= 300) continue;

    const method = (e.request?.method ?? 'GET').toUpperCase();
    const path = normalisePath(u.pathname);
    const key = `${method} ${path}`;
    const prev = observed.get(key);
    if (prev) prev.count += 1;
    else observed.set(key, { method, path, count: 1 });
  }

  // ── reconcile against the built-in templates ──
  const overrides: HarImportResult['overrides'] = [];
  const confirmed: string[] = [];
  const unseen: string[] = [];
  const matchedShapes = new Set<string>();
  const observedPaths = [...observed.values()];

  for (const [op, template] of Object.entries(DEFAULT_ENDPOINTS) as Array<[OperationName, string]>) {
    const shape = templateShape(template);

    const exact = observedPaths.find((o) => o.path === shape);
    if (exact) {
      confirmed.push(op);
      matchedShapes.add(exact.path);
      continue;
    }

    // The same endpoint under a different API generation is the common drift:
    // try every version variant before giving up.
    const variant = observedPaths.find((o) => sameIgnoringVersion(o.path, shape));
    if (variant) {
      const corrected = applyObservedVersion(template, variant.path);
      overrides.push({ operation: op, from: template, to: corrected });
      matchedShapes.add(variant.path);
      continue;
    }

    unseen.push(op);
  }

  const unmapped = observedPaths
    .filter((o) => !matchedShapes.has(o.path))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);

  // ── persist ──
  saveConfig({ baseUrl });

  const profile: EndpointProfile = {
    version: 1,
    overrides: Object.fromEntries(overrides.map((o) => [o.operation, o.to])) as Partial<EndpointMap>,
    source: file,
    capturedAt: new Date().toISOString(),
    observed: unmapped,
  };
  saveProfile(profile);

  // ── opportunistic session capture ──
  let sessionCaptured = false;
  if (opts.captureSession !== false) {
    const cookieHeader = findCookieHeader(entries, host);
    if (cookieHeader) {
      try {
        const session = await Session.fromCookieHeader(baseUrl, cookieHeader, {
          userAgent: userAgent ?? DEFAULT_USER_AGENT,
        });
        await session.persist();
        sessionCaptured = true;
        log.info('A session was recovered from the HAR.');
      } catch (err) {
        log.warn('HAR contained cookies but they were not usable', String(err));
      }
    }
  }

  return {
    baseUrl,
    entries: entries.length,
    apiEntries,
    overrides,
    confirmed,
    unseen,
    unmapped,
    sessionCaptured,
    userAgent,
  };
}

/** True when two normalised paths differ only in their `/vN/` segments. */
function sameIgnoringVersion(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/\/(?:public\/)?v\d+\//g, '/v/');
  return strip(a) === strip(b) && a !== b;
}

/**
 * Rewrites a template's version segments to match what the recording showed,
 * preserving the template's own named placeholders.
 */
function applyObservedVersion(template: string, observedPath: string): string {
  const observedVersions = [...observedPath.matchAll(/\/((?:public\/)?v\d+)\//g)].map((m) => m[1]!);
  let i = 0;
  return template.replace(/\/(?:public\/)?v\d+\//g, () => {
    const next = observedVersions[i++] ?? 'v1';
    return `/${next}/`;
  });
}

/** Finds a usable Cookie header for the instance host, if the HAR kept one. */
function findCookieHeader(entries: HarEntry[], host: string): string | undefined {
  for (const e of entries) {
    const url = e.request?.url;
    if (!url) continue;
    try {
      if (new URL(url).host !== host) continue;
    } catch {
      continue;
    }

    const header = e.request?.headers?.find((h) => h.name.toLowerCase() === 'cookie')?.value;
    if (header && /BbRouter=|JSESSIONID=/.test(header)) return header;

    const jar = e.request?.cookies ?? [];
    if (jar.length > 0) {
      const joined = jar.map((c) => `${c.name}=${c.value}`).join('; ');
      if (/BbRouter=|JSESSIONID=/.test(joined)) return joined;
    }
  }
  return undefined;
}
