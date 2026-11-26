/**
 * Minimal, strictly read-only Moodle LMS client.
 *
 * Supports two authentication modes against the exact configured HTTPS origin:
 *  1. Moodle Web Service REST token (`MOODLE_API_TOKEN`) sent in the POST body
 *     to `/webservice/rest/server.php` (never placed in URL query strings).
 *  2. Authenticated browser session cookie (`MOODLE_COOKIE`, e.g. `MoodleSession`)
 *     using `/my/` to resolve the in-memory `sesskey` and calling read-only
 *     Moodle AJAX webservice functions via `/lib/ajax/service.php`.
 *
 * Only functions explicitly listed in `ALLOWED_READ_FUNCTIONS` may be called.
 */

export const ALLOWED_READ_FUNCTIONS = new Set<string>([
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_course_get_contents',
  'mod_assign_get_assignments',
  'core_calendar_get_calendar_events',
  'core_calendar_get_action_events_by_timesort',
  'mod_forum_get_forums_by_courses',
  'mod_forum_get_forum_discussions',
  'gradereport_user_get_grade_items',
]);

export type MoodleErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOOL_NOT_ALLOWED'
  | 'BAD_INPUT'
  | 'UPSTREAM_FAILED';

export class MoodleError extends Error {
  constructor(
    readonly code: MoodleErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'MoodleError';
  }
}

export interface MoodleClientOptions {
  baseUrl: string;
  token?: string;
  cookie?: string;
  userAgent?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface MoodleSiteInfo {
  userid: number;
  username?: string;
  fullname?: string;
  sitename?: string;
  siteurl: string;
  release?: string;
  version?: string;
  lang?: string;
  auth_mode: 'token' | 'cookie';
}

interface CookieSessionState {
  sesskey: string;
  userid: number;
  sitename?: string;
  fullname?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const AUTH_ERROR_CODES = new Set([
  'invalidtoken',
  'servicerequireslogin',
  'requireloginerror',
  'invalidsesskey',
  'sessiontimeout',
  'forcepasswordchangenotice',
  'usernotconfirmed',
  'guestnocomment',
]);

const FORBIDDEN_ERROR_CODES = new Set([
  'nopermissions',
  'nopermissiontoview',
  'nopermission',
  'coursecontextnotvalid',
  'accessexception',
  'webservicenotavailable',
]);

const NOT_FOUND_ERROR_CODES = new Set([
  'invalidcourseid',
  'invalidrecord',
  'invalidrecordunknown',
  'dmlmissingrecordexception',
  'cannotfindcourse',
]);

/** Convert Moodle Unix epoch seconds to ISO-8601 UTC (or null when unset/zero). */
export function unixToIso(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Linear-time HTML-to-text converter with no backtracking tag regexes. */
export function stripHtml(input: unknown, maxChars = 4000): string {
  if (typeof input !== 'string' || !input) return '';
  let out = '';
  let inTag = false;
  let lastSpace = true;

  for (let i = 0; i < input.length && out.length < maxChars + 64; i++) {
    const ch = input[i]!;
    if (ch === '<') {
      inTag = true;
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (inTag) continue;
    if (ch === '\r' || ch === '\n' || ch === '\t' || ch === ' ') {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += ch;
      lastSpace = false;
    }
  }

  const decoded = out
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim();

  if (decoded.length <= maxChars) return decoded;
  return `${decoded.slice(0, maxChars).trimEnd()}...`;
}

/** Flatten nested arguments into Moodle REST PHP form fields (e.g. courseids[0]=42). */
export function appendFormParams(params: URLSearchParams, prefix: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormParams(params, `${prefix}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      appendFormParams(params, `${prefix}[${key}]`, nested);
    }
    return;
  }
  if (typeof value === 'boolean') {
    params.append(prefix, value ? '1' : '0');
    return;
  }
  params.append(prefix, String(value));
}

function classifyMoodleException(errorcode: string | undefined, message: string | undefined): MoodleError {
  const code = (errorcode ?? '').toLowerCase();
  const detail = message || code || 'Moodle returned an error.';
  if (AUTH_ERROR_CODES.has(code) || /invalid token|session.*expired|not logged in|login required/i.test(detail)) {
    return new MoodleError('AUTH_REQUIRED', detail);
  }
  if (FORBIDDEN_ERROR_CODES.has(code)) {
    return new MoodleError('FORBIDDEN', detail);
  }
  if (NOT_FOUND_ERROR_CODES.has(code)) {
    return new MoodleError('NOT_FOUND', detail);
  }
  return new MoodleError('UPSTREAM_FAILED', detail);
}

/** Extract in-memory sesskey and userId from an authenticated Moodle `/my/` page. */
export function parseMoodleDashboard(html: string): CookieSessionState | null {
  if (!html) return null;
  if (/\b(?:loginform|id=["']login["']|name=["']logintoken["']|\/login\/index\.php)\b/i.test(html) && !/"sesskey"\s*:\s*"[A-Za-z0-9_-]{4,64}"/.test(html)) {
    return null;
  }
  const sesskeyMatch = /"sesskey"\s*:\s*"([A-Za-z0-9_-]{4,64})"/.exec(html);
  if (!sesskeyMatch?.[1]) return null;
  const userMatch =
    /"userId"\s*:\s*(\d{1,12})/.exec(html) ??
    /data-userid=["'](\d{1,12})["']/.exec(html) ??
    /"userid"\s*:\s*(\d{1,12})/.exec(html);
  const userid = userMatch?.[1] ? Number(userMatch[1]) : 0;
  if (!Number.isSafeInteger(userid) || userid <= 0) return null;

  const titleMatch = /<title>([^<]{1,200})<\/title>/i.exec(html);
  const sitename = titleMatch?.[1]?.trim() || undefined;
  return { sesskey: sesskeyMatch[1], userid, sitename };
}

export class MoodleClient {
  readonly baseOrigin: string;
  readonly mode: 'token' | 'cookie';
  private readonly token?: string;
  private readonly cookie?: string;
  private readonly userAgent?: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private cachedSiteInfo: MoodleSiteInfo | null = null;
  private cachedCookieSession: CookieSessionState | null = null;

  constructor(options: MoodleClientOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new MoodleError('BAD_INPUT', 'Invalid Moodle base URL.');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new MoodleError('BAD_INPUT', 'Moodle base URL must be an HTTPS origin with no path, query, or credentials.');
    }
    this.baseOrigin = parsed.origin;
    this.token = options.token?.trim() || undefined;
    this.cookie = options.cookie?.trim() || undefined;
    this.userAgent = options.userAgent?.trim() || undefined;
    if (this.token) {
      this.mode = 'token';
    } else if (this.cookie) {
      this.mode = 'cookie';
    } else {
      throw new MoodleError('AUTH_REQUIRED', 'No Moodle credentials configured.');
    }
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  static fromEnvironment(fetcher?: typeof fetch): MoodleClient {
    const baseUrl = process.env.MOODLE_BASE_URL;
    if (!baseUrl) throw new MoodleError('BAD_INPUT', 'MOODLE_BASE_URL is not configured.');
    return new MoodleClient({
      baseUrl,
      token: process.env.MOODLE_API_TOKEN,
      cookie: process.env.MOODLE_COOKIE,
      userAgent: process.env.MOODLE_USER_AGENT,
      fetcher,
    });
  }

  private sameOriginUrl(path: string): URL {
    const url = new URL(path, this.baseOrigin);
    if (url.protocol !== 'https:' || url.origin !== this.baseOrigin || url.username || url.password) {
      throw new MoodleError('BAD_INPUT', 'Refusing a Moodle request outside the configured HTTPS origin.');
    }
    return url;
  }

  private async readBoundedText(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new MoodleError('UPSTREAM_FAILED', 'Moodle response exceeded size limit.');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          throw new MoodleError('UPSTREAM_FAILED', 'Moodle response exceeded size limit.');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private async ensureCookieSession(): Promise<CookieSessionState> {
    if (this.cachedCookieSession) return this.cachedCookieSession;
    const url = this.sameOriginUrl('/my/');
    const headers: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: this.cookie!,
      ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
    };
    const res = await this.fetcher(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle redirected to sign-in; session cookie expired or invalid.');
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle rejected the session cookie (401).');
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('FORBIDDEN', 'Moodle denied access to /my/ (403).');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('UPSTREAM_FAILED', `Moodle dashboard returned HTTP ${res.status}.`);
    }

    const html = await this.readBoundedText(res);
    const parsed = parseMoodleDashboard(html);
    if (!parsed) {
      throw new MoodleError('AUTH_REQUIRED', 'Moodle dashboard did not expose an authenticated non-guest session.');
    }
    this.cachedCookieSession = parsed;
    return parsed;
  }

  async callFunction<T = unknown>(wsfunction: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!ALLOWED_READ_FUNCTIONS.has(wsfunction)) {
      throw new MoodleError('TOOL_NOT_ALLOWED', `Moodle function "${wsfunction}" is not on the reviewed read-only allowlist.`);
    }

    if (this.mode === 'token') {
      return this.callRestToken<T>(wsfunction, args);
    }
    return this.callAjaxCookie<T>(wsfunction, args);
  }

  private async callRestToken<T>(wsfunction: string, args: Record<string, unknown>): Promise<T> {
    const url = this.sameOriginUrl('/webservice/rest/server.php');
    const body = new URLSearchParams();
    body.set('wstoken', this.token!);
    body.set('wsfunction', wsfunction);
    body.set('moodlewsrestformat', 'json');
    for (const [key, value] of Object.entries(args)) {
      appendFormParams(body, key, value);
    }

    const res = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
        ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
      },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle redirected the webservice request.');
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle rejected the API token (401).');
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('FORBIDDEN', 'Moodle denied access to this webservice function (403).');
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('NOT_FOUND', 'Moodle webservice endpoint not found (404).');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('UPSTREAM_FAILED', `Moodle webservice returned HTTP ${res.status}.`);
    }

    const raw = await this.readBoundedText(res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(raw)) {
        throw new MoodleError('AUTH_REQUIRED', 'Moodle returned HTML instead of JSON.');
      }
      throw new MoodleError('UPSTREAM_FAILED', 'Moodle returned invalid JSON.');
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('exception' in parsed || 'errorcode' in parsed)) {
      const err = parsed as { errorcode?: string; message?: string };
      throw classifyMoodleException(err.errorcode, err.message);
    }

    return parsed as T;
  }

  private async callAjaxCookie<T>(wsfunction: string, args: Record<string, unknown>): Promise<T> {
    const session = await this.ensureCookieSession();
    const url = this.sameOriginUrl(
      `/lib/ajax/service.php?sesskey=${encodeURIComponent(session.sesskey)}&info=${encodeURIComponent(wsfunction)}`,
    );

    const res = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: this.cookie!,
        ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
      },
      body: JSON.stringify([{ index: 0, methodname: wsfunction, args }]),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      this.cachedCookieSession = null;
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle redirected the AJAX request.');
    }
    if (res.status === 401) {
      this.cachedCookieSession = null;
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('AUTH_REQUIRED', 'Moodle rejected the session cookie (401).');
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('FORBIDDEN', 'Moodle denied access to this AJAX function (403).');
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('NOT_FOUND', 'Moodle AJAX service endpoint not found (404).');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MoodleError('UPSTREAM_FAILED', `Moodle AJAX service returned HTTP ${res.status}.`);
    }

    const raw = await this.readBoundedText(res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.cachedCookieSession = null;
      if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(raw)) {
        throw new MoodleError('AUTH_REQUIRED', 'Moodle returned HTML instead of JSON.');
      }
      throw new MoodleError('UPSTREAM_FAILED', 'Moodle returned invalid JSON.');
    }

    if (Array.isArray(parsed)) {
      const first = parsed[0] as { error?: boolean; data?: T; exception?: { errorcode?: string; message?: string } } | undefined;
      if (!first) throw new MoodleError('UPSTREAM_FAILED', 'Moodle AJAX response was empty.');
      if (first.error) {
        const mapped = classifyMoodleException(first.exception?.errorcode, first.exception?.message);
        if (mapped.code === 'AUTH_REQUIRED') this.cachedCookieSession = null;
        throw mapped;
      }
      return first.data as T;
    }

    if (parsed && typeof parsed === 'object' && ('exception' in parsed || 'errorcode' in parsed)) {
      const err = parsed as { errorcode?: string; message?: string };
      const mapped = classifyMoodleException(err.errorcode, err.message);
      if (mapped.code === 'AUTH_REQUIRED') this.cachedCookieSession = null;
      throw mapped;
    }

    throw new MoodleError('UPSTREAM_FAILED', 'Unexpected Moodle AJAX response format.');
  }

  async getSiteInfo(): Promise<MoodleSiteInfo> {
    if (this.cachedSiteInfo) return this.cachedSiteInfo;
    if (this.mode === 'token') {
      const data = await this.callFunction<Record<string, unknown>>('core_webservice_get_site_info');
      const userid = Number(data?.userid);
      if (!Number.isSafeInteger(userid) || userid <= 0) {
        throw new MoodleError('AUTH_REQUIRED', 'Moodle site info probe did not return an authenticated user ID.');
      }
      this.cachedSiteInfo = {
        userid,
        username: typeof data.username === 'string' ? data.username : undefined,
        fullname: typeof data.fullname === 'string' ? data.fullname : undefined,
        sitename: typeof data.sitename === 'string' ? data.sitename : undefined,
        siteurl: this.baseOrigin,
        release: typeof data.release === 'string' ? data.release : undefined,
        version: typeof data.version === 'string' ? data.version : undefined,
        lang: typeof data.lang === 'string' ? data.lang : undefined,
        auth_mode: 'token',
      };
      return this.cachedSiteInfo;
    }

    const session = await this.ensureCookieSession();
    this.cachedSiteInfo = {
      userid: session.userid,
      sitename: session.sitename,
      siteurl: this.baseOrigin,
      auth_mode: 'cookie',
    };
    return this.cachedSiteInfo;
  }

  async listCourses(options: { classification?: 'all' | 'inprogress' | 'future' | 'past'; limit?: number } = {}) {
    const classification = options.classification ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    let rawCourses: Array<Record<string, unknown>>;

    if (this.mode === 'token') {
      const site = await this.getSiteInfo();
      const rows = await this.callFunction<Array<Record<string, unknown>>>('core_enrol_get_users_courses', {
        userid: site.userid,
      });
      const nowSec = Math.floor(Date.now() / 1000);
      rawCourses = (Array.isArray(rows) ? rows : []).filter((c) => {
        if (classification === 'all') return true;
        const start = typeof c.startdate === 'number' ? c.startdate : 0;
        const end = typeof c.enddate === 'number' ? c.enddate : 0;
        if (classification === 'future') return start > nowSec;
        if (classification === 'past') return end > 0 && end < nowSec;
        return (start === 0 || start <= nowSec) && (end === 0 || end >= nowSec);
      });
    } else {
      const data = await this.callFunction<{ courses?: Array<Record<string, unknown>> }>(
        'core_course_get_enrolled_courses_by_timeline_classification',
        { classification, limit, offset: 0, sort: 'fullname' },
      );
      rawCourses = Array.isArray(data?.courses) ? data.courses : [];
    }

    const truncated = rawCourses.length > limit;
    const courses = rawCourses.slice(0, limit).map((c) => ({
      id: Number(c.id),
      shortname: typeof c.shortname === 'string' ? c.shortname : undefined,
      fullname: typeof c.fullname === 'string' ? c.fullname : typeof c.displayname === 'string' ? c.displayname : '',
      start_at: unixToIso(c.startdate),
      end_at: unixToIso(c.enddate),
      visible: c.visible === undefined ? true : Boolean(c.visible),
      url: Number.isSafeInteger(Number(c.id)) ? `${this.baseOrigin}/course/view.php?id=${Number(c.id)}` : undefined,
    }));

    return { courses, count: courses.length, classification, truncated };
  }

  async getCourseContents(courseId: number) {
    const sections = await this.callFunction<Array<Record<string, unknown>>>('core_course_get_contents', {
      courseid: courseId,
    });
    const list = (Array.isArray(sections) ? sections : []).slice(0, 60).map((section) => {
      const modules = (Array.isArray(section.modules) ? (section.modules as Array<Record<string, unknown>>) : [])
        .slice(0, 100)
        .map((mod) => ({
          id: Number(mod.id),
          name: typeof mod.name === 'string' ? mod.name : '',
          modname: typeof mod.modname === 'string' ? mod.modname : undefined,
          url: typeof mod.url === 'string' ? mod.url : undefined,
          description: stripHtml(mod.description, 800) || undefined,
          contents: (Array.isArray(mod.contents) ? (mod.contents as Array<Record<string, unknown>>) : [])
            .slice(0, 30)
            .map((item) => ({
              type: typeof item.type === 'string' ? item.type : undefined,
              filename: typeof item.filename === 'string' ? item.filename : undefined,
              filesize: typeof item.filesize === 'number' ? item.filesize : undefined,
              mimetype: typeof item.mimetype === 'string' ? item.mimetype : undefined,
              modified_at: unixToIso(item.timemodified),
            })),
        }));
      return {
        id: Number(section.id),
        name: typeof section.name === 'string' ? section.name : '',
        summary: stripHtml(section.summary, 800) || undefined,
        modules,
      };
    });
    return { course_id: courseId, sections: list, truncated: Array.isArray(sections) && sections.length > 60 };
  }

  async listAssignments(courseId?: number) {
    const data = await this.callFunction<{
      courses?: Array<{ id: number; fullname?: string; shortname?: string; assignments?: Array<Record<string, unknown>> }>;
      warnings?: Array<Record<string, unknown>>;
    }>('mod_assign_get_assignments', courseId ? { courseids: [courseId] } : {});

    const assignments: Array<Record<string, unknown>> = [];
    for (const course of data?.courses ?? []) {
      for (const item of course.assignments ?? []) {
        assignments.push({
          id: Number(item.id),
          cmid: typeof item.cmid === 'number' ? item.cmid : undefined,
          course_id: Number(course.id),
          course_name: course.fullname ?? course.shortname ?? undefined,
          name: typeof item.name === 'string' ? item.name : '',
          due_at: unixToIso(item.duedate),
          cutoff_at: unixToIso(item.cutoffdate),
          allow_submissions_from: unixToIso(item.allowsubmissionsfromdate),
          modified_at: unixToIso(item.timemodified),
          intro: stripHtml(item.intro, 1200) || undefined,
          url: typeof item.cmid === 'number' ? `${this.baseOrigin}/mod/assign/view.php?id=${item.cmid}` : undefined,
        });
      }
    }
    return {
      assignments: assignments.slice(0, 200),
      count: assignments.length,
      truncated: assignments.length > 200,
      warnings: Array.isArray(data?.warnings) && data.warnings.length ? data.warnings.length : 0,
    };
  }

  async listCalendarEvents(options: { daysAhead?: number; daysBack?: number; limit?: number } = {}) {
    const daysAhead = Math.min(Math.max(options.daysAhead ?? 14, 1), 90);
    const daysBack = Math.min(Math.max(options.daysBack ?? 0, 0), 30);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - daysBack * 86_400;
    const toSec = nowSec + daysAhead * 86_400;

    let rawEvents: Array<Record<string, unknown>>;
    if (this.mode === 'token') {
      const data = await this.callFunction<{ events?: Array<Record<string, unknown>> }>('core_calendar_get_calendar_events', {
        options: { timestart: fromSec, timeend: toSec, userevents: 1, siteevents: 1, ignorehidden: 1 },
      });
      rawEvents = Array.isArray(data?.events) ? data.events : [];
    } else {
      const data = await this.callFunction<{ events?: Array<Record<string, unknown>> }>(
        'core_calendar_get_action_events_by_timesort',
        { timesortfrom: fromSec, timesortto: toSec, limitnum: limit },
      );
      rawEvents = Array.isArray(data?.events) ? data.events : [];
    }

    const truncated = rawEvents.length > limit;
    const events = rawEvents.slice(0, limit).map((ev) => ({
      id: Number(ev.id),
      name: typeof ev.name === 'string' ? ev.name : '',
      course_id: typeof ev.courseid === 'number' ? ev.courseid : typeof (ev.course as Record<string, unknown> | undefined)?.id === 'number' ? Number((ev.course as Record<string, unknown>).id) : undefined,
      event_type: typeof ev.eventtype === 'string' ? ev.eventtype : undefined,
      module: typeof ev.modulename === 'string' ? ev.modulename : undefined,
      starts_at: unixToIso(ev.timestart ?? ev.timesort),
      ends_at: typeof ev.timestart === 'number' && typeof ev.timeduration === 'number' && ev.timeduration > 0 ? unixToIso(ev.timestart + ev.timeduration) : null,
      description: stripHtml(ev.description, 1000) || undefined,
      url: typeof ev.url === 'string' ? ev.url : undefined,
    }));

    return {
      events,
      count: events.length,
      window: { from: unixToIso(fromSec), to: unixToIso(toSec) },
      truncated,
    };
  }

  async listForums(courseId?: number) {
    const rows = await this.callFunction<Array<Record<string, unknown>>>(
      'mod_forum_get_forums_by_courses',
      courseId ? { courseids: [courseId] } : {},
    );
    const forums = (Array.isArray(rows) ? rows : []).slice(0, 100).map((f) => ({
      id: Number(f.id),
      cmid: typeof f.cmid === 'number' ? f.cmid : undefined,
      course_id: Number(f.course),
      name: typeof f.name === 'string' ? f.name : '',
      type: typeof f.type === 'string' ? f.type : undefined,
      intro: stripHtml(f.intro, 800) || undefined,
      url: typeof f.cmid === 'number' ? `${this.baseOrigin}/mod/forum/view.php?id=${f.cmid}` : undefined,
    }));
    return { forums, count: forums.length, truncated: Array.isArray(rows) && rows.length > 100 };
  }

  async listDiscussions(forumId: number, limit = 20) {
    const perpage = Math.min(Math.max(limit, 1), 50);
    const data = await this.callFunction<{ discussions?: Array<Record<string, unknown>> }>(
      'mod_forum_get_forum_discussions',
      { forumid: forumId, page: 0, perpage },
    );
    const rows = Array.isArray(data?.discussions) ? data.discussions : [];
    const discussions = rows.slice(0, perpage).map((d) => ({
      id: Number(d.discussion ?? d.id),
      subject: typeof d.subject === 'string' ? d.subject : typeof d.name === 'string' ? d.name : '',
      author: typeof d.userfullname === 'string' ? d.userfullname : undefined,
      created_at: unixToIso(d.created),
      modified_at: unixToIso(d.timemodified),
      pinned: Boolean(d.pinned),
      message: stripHtml(d.message, 4000) || undefined,
      url: Number.isSafeInteger(Number(d.discussion ?? d.id))
        ? `${this.baseOrigin}/mod/forum/discuss.php?d=${Number(d.discussion ?? d.id)}`
        : undefined,
    }));
    return { forum_id: forumId, discussions, count: discussions.length, truncated: rows.length >= perpage };
  }

  async getGrades(courseId: number) {
    const site = await this.getSiteInfo();
    const data = await this.callFunction<{
      usergrades?: Array<{ courseid?: number; gradeitems?: Array<Record<string, unknown>> }>;
    }>('gradereport_user_get_grade_items', { courseid: courseId, userid: site.userid });

    const gradeItems = (data?.usergrades?.[0]?.gradeitems ?? []).slice(0, 200).map((g) => ({
      id: Number(g.id),
      item_name: typeof g.itemname === 'string' ? g.itemname : typeof g.itemtype === 'string' ? g.itemtype : '',
      item_module: typeof g.itemmodule === 'string' ? g.itemmodule : undefined,
      grade_raw: typeof g.graderaw === 'number' ? g.graderaw : null,
      grade_formatted: stripHtml(g.gradeformatted, 120) || undefined,
      grade_min: typeof g.grademin === 'number' ? g.grademin : undefined,
      grade_max: typeof g.grademax === 'number' ? g.grademax : undefined,
      percentage: stripHtml(g.percentageformatted, 60) || undefined,
      feedback: stripHtml(g.feedback, 1500) || undefined,
    }));
    return { course_id: courseId, items: gradeItems, count: gradeItems.length };
  }

  async listAnnouncements(options: { courseId?: number; limit?: number; maxCourses?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
    const maxCourses = Math.min(Math.max(options.maxCourses ?? 10, 1), 10);
    const { forums } = await this.listForums(options.courseId);
    const newsForums = forums.filter((f) => f.type === 'news');
    const selected = newsForums.slice(0, maxCourses);
    const announcements: Array<Record<string, unknown>> = [];
    const failedForums: Array<{ forum_id: number; course_id: number; reason: string }> = [];

    for (const forum of selected) {
      try {
        const { discussions } = await this.listDiscussions(forum.id, limit);
        for (const d of discussions) {
          announcements.push({
            ...d,
            forum_id: forum.id,
            forum_name: forum.name,
            course_id: forum.course_id,
          });
        }
      } catch (err) {
        if (err instanceof MoodleError && err.code === 'AUTH_REQUIRED') throw err;
        failedForums.push({
          forum_id: forum.id,
          course_id: forum.course_id,
          reason: err instanceof MoodleError ? err.code : 'UPSTREAM_FAILED',
        });
      }
    }

    return {
      announcements,
      count: announcements.length,
      forums_checked: selected.length,
      forums_total: newsForums.length,
      truncated: newsForums.length > selected.length,
      partial: failedForums.length > 0,
      failed_forums: failedForums,
    };
  }
}
