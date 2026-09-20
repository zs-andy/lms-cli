import { Session } from '../auth/session.js';
import { loadConfigOrNull, type Config } from '../config.js';
import { HttpClient } from './http.js';
import { expand } from './endpoints.js';
import { notConfigured, BlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type {
  Paged, BbUser, BbCourse, BbTerm, BbMembership, BbContent, BbAttachment,
  BbGradeColumn, BbGrade, BbAttempt, BbAttemptFile, BbAnnouncement,
  BbCalendarItem, BbTodoItem, BbTodoResponse, BbConversation,
  BbConversationMessage, BbForumMessage, BbAttendanceRecord, BbStreamResponse,
  BbFileDetail, BbGradeSchema, BbSubmissionService, BbGradeAttemptRow,
  BbQuestionAttempt, BbAnswerGrade,
} from './types.js';

export * from './types.js';
export { HttpClient } from './http.js';

export interface ListOptions {
  /** Max rows to return across all pages. Defaults to config.pageSize. */
  limit?: number;
  offset?: number;
}

/** One read in a `utilities/batch` fan-out. */
export interface BatchRequest {
  method: 'GET';
  /** Version-relative, e.g. `v1/courses/_12345_1/gradebook/columns?limit=100`. */
  relativeUrl: string;
}

export interface BatchResult<T = unknown> {
  status?: number;
  code?: number;
  body?: T;
}

export class BlackboardClient {
  private selfCache: BbUser | null = null;
  private courseNameCache = new Map<string, string>();

  constructor(
    readonly http: HttpClient,
    readonly config: Config,
  ) {}

  static async create(): Promise<BlackboardClient> {
    const config = loadConfigOrNull();
    if (!config) throw notConfigured();
    const session = await Session.load();
    if (session.baseUrl !== config.baseUrl) {
      throw new BlackboardError('NOT_AUTHENTICATED', 'Stored session belongs to a different instance.', {
        hint: `Session is for ${session.baseUrl} but config points at ${config.baseUrl}. Run \`blackboard-mcp auth login\` again.`,
      });
    }
    return new BlackboardClient(new HttpClient(session, config), config);
  }

  // ── pagination ──────────────────────────────────────────────────────────

  /**
   * Walks the `paging.nextPage` chain until `limit` rows are collected.
   *
   * The v1 API reports no-more-pages as an *empty string* rather than a missing
   * field, and caps `limit` server-side, so we always page rather than asking
   * for everything at once.
   */
  async paginate<T>(
    path: string,
    opts: ListOptions & { query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T[]> {
    const limit = opts.limit ?? this.config.pageSize;
    const out: T[] = [];
    let next: string | undefined = path;
    let query: Record<string, string | number | boolean | undefined> | undefined = {
      ...opts.query,
      limit: Math.min(limit, 100),
      offset: opts.offset ?? 0,
    };

    for (let guard = 0; next && out.length < limit && guard < 50; guard += 1) {
      const page: Paged<T> = await this.http.json<Paged<T>>({ path: next, query });
      const rows = page?.results ?? [];
      out.push(...rows);
      next = page?.paging?.nextPage || undefined;
      query = undefined; // nextPage already carries its own query string.
      if (rows.length === 0) break;
    }
    return out.slice(0, limit);
  }

  /** Total row count for a list endpoint, without fetching the rows. */
  async count(path: string, query?: Record<string, string | number | undefined>): Promise<number> {
    const page = await this.http.json<Paged<unknown>>({
      path,
      query: { ...query, limit: 1, includeCount: true },
    });
    return page?.paging?.count ?? page?.results?.length ?? 0;
  }

  /**
   * Fans out up to ~20 reads in a single round trip via `utilities/batch`.
   *
   * This is how the Ultra front end avoids N+1 storms, and it is the difference
   * between "list every deadline across 8 courses" taking one request or twenty.
   * `relativeUrl` is version-relative (`v1/...`), not absolute.
   */
  async batch<T = unknown>(requests: BatchRequest[]): Promise<Array<BatchResult<T>>> {
    if (requests.length === 0) return [];
    const CHUNK = 20;
    const out: Array<BatchResult<T>> = [];
    for (let i = 0; i < requests.length; i += CHUNK) {
      const slice = requests.slice(i, i + CHUNK);
      // The batch endpoint is a PUT but performs only the reads it is given, so
      // it must bypass the read-only write guard.
      const res = await this.http.json<Array<BatchResult<T>> | { results?: Array<BatchResult<T>> }>({
        method: 'PUT',
        path: expand('batch'),
        query: { xb: 0 },
        body: slice,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        forceAllowWrite: true,
      });
      const rows = Array.isArray(res) ? res : (res?.results ?? []);
      out.push(...rows);
    }
    return out;
  }

  // ── session ─────────────────────────────────────────────────────────────

  /**
   * Seconds until the session expires; 0 or negative means already gone.
   *
   * Blackboard answers with `{timeBeforeTimeout, timeBeforeTimeoutToShowWarning}`
   * in **milliseconds**. A fresh session reads about 10,800,000 (three hours).
   * Other shapes are tolerated because this is an internal endpoint.
   */
  async sessionSecondsRemaining(): Promise<number> {
    const res = await this.http.json<
      number | { timeBeforeTimeout?: number; seconds?: number; value?: number }
    >({ path: expand('sessionTtl'), retries: 0, allowRefresh: false });

    if (typeof res === 'number') return res;
    if (typeof res?.timeBeforeTimeout === 'number') {
      return Math.round(res.timeBeforeTimeout / 1000);
    }
    return res?.seconds ?? res?.value ?? 0;
  }

  /** Extends the session without doing real work. */
  async keepAlive(): Promise<void> {
    await this.http.request({
      path: expand('sessionKeepAlive'),
      retries: 0,
      allowNotFound: true,
      allowRefresh: false,
    });
  }

  /**
   * Keeps the session alive for as long as the process runs.
   *
   * Two mechanisms, because they cover different failures:
   *
   *  - **Keep-alive** pings Blackboard's own endpoint, which resets the
   *    inactivity timer. A session that is merely idle never expires.
   *  - **Silent renewal** replays the institution's SSO chain, which recovers a
   *    session that expired anyway (laptop asleep, absolute-lifetime cap).
   *
   * The result is that a user signs in once and is not asked again for as long
   * as their identity-provider session lives. Typically weeks.
   *
   * Returns a stop function.
   */
  startSessionKeeper(opts: { intervalMs?: number; thresholdSeconds?: number } = {}): () => void {
    const interval = opts.intervalMs ?? 10 * 60_000;
    const threshold = opts.thresholdSeconds ?? 20 * 60;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const remaining = await this.sessionSecondsRemaining();
        if (remaining <= 0) {
          log.info('Session expired; attempting silent renewal');
          const ok = await this.http.tryRefresh();
          log.info(ok ? 'Session renewed' : 'Silent renewal unavailable. User must sign in again');
          return;
        }
        if (remaining < threshold) {
          log.debug(`Session has ${Math.round(remaining / 60)} min left; pinging keep-alive`);
          await this.keepAlive();
        }
      } catch (err) {
        // A failed probe is usually the session already being gone; let the
        // renewal path handle it rather than treating it as fatal.
        log.debug('Session keeper tick failed', (err as Error).message);
        await this.http.tryRefresh().catch(() => false);
      }
    };

    const timer = setInterval(() => void tick(), interval);
    // Never hold the event loop open on this alone.
    timer.unref?.();
    void tick();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // ── identity ────────────────────────────────────────────────────────────

  async whoami(): Promise<BbUser> {
    if (this.selfCache) return this.selfCache;
    const user = await this.http.json<BbUser>({
      path: expand('self'),
      query: { expand: 'systemRoles,insRoles' },
    });
    this.selfCache = user;
    this.http.session.user = {
      id: user.id,
      userName: user.userName,
      displayName: displayName(user),
    };
    await this.http.session.persist();
    return user;
  }

  async selfId(): Promise<string> {
    return (await this.whoami()).id;
  }

  async getUser(userId: string): Promise<BbUser> {
    return this.http.json<BbUser>({ path: expand('user', { userId }) });
  }

  // ── courses ─────────────────────────────────────────────────────────────

  /**
   * The user's course memberships, with each course expanded.
   *
   * `includeCount` plus a high limit is what the Ultra course list itself does;
   * course counts are small enough (tens) that one request is correct here.
   */
  async listCourses(
    opts: { userId?: string; includeHidden?: boolean; availableOnly?: boolean; organizations?: 'exclude' | 'only' | 'include' } = {},
  ): Promise<BbMembership[]> {
    const query = {
      expand: 'course.effectiveAvailability,course.permissions,courseRole',
      includeCount: true,
      limit: 10000,
    };

    // `/users/me/memberships` is the tidier path but is not present on every
    // Learn release, so fall back to the id-scoped form, which is.
    let page: Paged<BbMembership>;
    if (opts.userId) {
      page = await this.http.json<Paged<BbMembership>>({
        path: expand('userMemberships', { userId: opts.userId }),
        query,
      });
    } else {
      try {
        page = await this.http.json<Paged<BbMembership>>({
          path: expand('selfMemberships'),
          query,
          retries: 0,
        });
      } catch (err) {
        const code = err instanceof BlackboardError ? err.code : '';
        if (code !== 'NOT_FOUND' && code !== 'FORBIDDEN') throw err;
        log.debug('users/me/memberships unavailable; falling back to the id-scoped path');
        page = await this.http.json<Paged<BbMembership>>({
          path: expand('userMemberships', { userId: await this.selfId() }),
          query,
        });
      }
    }
    let rows = page?.results ?? [];

    for (const m of rows) {
      if (m.course?.id) {
        this.courseNameCache.set(m.course.id, courseLabel(m.course));
      }
    }

    if (!opts.includeHidden) rows = rows.filter((m) => !m.userHasHidden);
    if (opts.availableOnly) {
      rows = rows.filter((m) => m.isAvailable !== false && m.course?.isAvailable !== false);
    }
    const orgMode = opts.organizations ?? 'exclude';
    if (orgMode === 'exclude') rows = rows.filter((m) => !m.course?.isOrganization);
    if (orgMode === 'only') rows = rows.filter((m) => m.course?.isOrganization);

    return rows;
  }

  async getCourse(courseId: string): Promise<BbCourse> {
    const course = await this.http.json<BbCourse>({ path: expand('course', { courseId }) });
    this.courseNameCache.set(courseId, courseLabel(course));
    return course;
  }

  /** Best-effort human label for a course id, using whatever is already cached. */
  async courseName(courseId: string): Promise<string> {
    const cached = this.courseNameCache.get(courseId);
    if (cached) return cached;
    try {
      return courseLabel(await this.getCourse(courseId));
    } catch {
      return courseId;
    }
  }

  async listTerms(opts: ListOptions = {}): Promise<BbTerm[]> {
    return this.paginate<BbTerm>(expand('terms'), opts);
  }

  async listRoster(courseId: string, opts: ListOptions = {}): Promise<BbMembership[]> {
    return this.paginate<BbMembership>(expand('courseRoster', { courseId }), {
      ...opts,
      query: { expand: 'user,courseRole' },
    });
  }

  async listCourseGroups(courseId: string, opts: ListOptions = {}): Promise<unknown[]> {
    return this.paginate(expand('courseGroups', { courseId }), opts);
  }

  async listCourseTools(courseId: string): Promise<unknown[]> {
    return this.paginate(expand('courseTools', { courseId }), { limit: 100 });
  }

  // ── content ─────────────────────────────────────────────────────────────

  /** Top-level items of a course outline. */
  async listTopLevelContents(courseId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    const rows = await this.paginate<BbContent>(expand('contentsRoot', { courseId }), {
      limit: opts.limit ?? 200,
      offset: opts.offset,
      query: {
        '@view': 'Summary',
        expand: 'assignedGroups,selfEnrollmentGroups.group,gradebookCategory',
        includeInActivityTracking: true,
      },
    });
    return rows.map((c) => ({ ...c, _courseId: courseId, _depth: 0 }));
  }

  /**
   * Items under the `INTERACTIVE` root: discussions, journals and other
   * participation activities, which Ultra deliberately keeps out of the course
   * outline. Absent on tenants with the feature disabled, hence the soft fail.
   */
  async listInteractiveContents(courseId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    try {
      const rows = await this.paginate<BbContent>(expand('contentsInteractive', { courseId }), {
        limit: opts.limit ?? 100,
        query: { '@view': 'Summary' },
      });
      return rows.map((c) => ({ ...c, _courseId: courseId, _depth: 0 }));
    } catch (err) {
      log.debug(`No INTERACTIVE content for ${courseId}`, String(err));
      return [];
    }
  }

  async getContent(courseId: string, contentId: string): Promise<BbContent> {
    const c = await this.http.json<BbContent>({
      path: expand('content', { courseId, contentId }),
    });
    return { ...c, _courseId: courseId };
  }

  async listChildren(courseId: string, contentId: string, opts: ListOptions = {}): Promise<BbContent[]> {
    const rows = await this.paginate<BbContent>(
      expand('contentChildren', { courseId, contentId }),
      {
        limit: opts.limit ?? 200,
        offset: opts.offset,
        query: { '@view': 'Summary', expand: 'gradebookCategory' },
      },
    );
    return rows.map((c) => ({ ...c, _courseId: courseId }));
  }

  /**
   * Depth-first walk of a course's content tree.
   *
   * There is no reliable recursive-listing endpoint, so we walk it. Folders and
   * lessons are the only containers; `hasChildren` is absent on some tenants, so
   * we fall back to inspecting the handler's `contentDetail` for `isFolder`.
   */
  async walkContents(
    courseId: string,
    opts: { maxDepth?: number; maxNodes?: number; rootId?: string; includeInteractive?: boolean } = {},
  ): Promise<BbContent[]> {
    const maxDepth = opts.maxDepth ?? 6;
    const maxNodes = opts.maxNodes ?? 600;
    const out: BbContent[] = [];
    const seen = new Set<string>();

    const visit = async (nodes: BbContent[], depth: number, prefix: string): Promise<void> => {
      for (const node of nodes) {
        if (out.length >= maxNodes) return;
        if (seen.has(node.id)) continue; // Course links can create cycles.
        seen.add(node.id);

        const label = node.title ?? node.id;
        const path = prefix ? `${prefix} / ${label}` : label;
        out.push({ ...node, _courseId: courseId, _path: path, _depth: depth });

        if (isContainer(node) && depth < maxDepth) {
          try {
            const children = await this.listChildren(courseId, node.id, { limit: 200 });
            await visit(children, depth + 1, path);
          } catch (err) {
            // A single unreadable folder must not abort the whole walk.
            log.debug(`Skipping children of ${node.id}`, String(err));
          }
        }
      }
    };

    if (opts.rootId) {
      await visit(await this.listChildren(courseId, opts.rootId, { limit: 200 }), 0, '');
      return out;
    }

    await visit(await this.listTopLevelContents(courseId, { limit: 200 }), 0, '');

    // Discussions and journals hang off a separate root; include them unless
    // the caller explicitly narrowed to a subtree.
    if (opts.includeInteractive !== false) {
      const interactive = await this.listInteractiveContents(courseId, { limit: 100 });
      if (interactive.length > 0) await visit(interactive, 0, 'Discussions & activities');
    }
    return out;
  }

  async listAttachments(courseId: string, contentId: string): Promise<BbAttachment[]> {
    return this.paginate<BbAttachment>(
      expand('contentAttachments', { courseId, contentId }),
      { limit: 100 },
    );
  }

  /** Marks a reviewable content item as reviewed. Requires writes enabled. */
  async markReviewed(courseId: string, contentId: string, reviewed = true): Promise<void> {
    await this.http.request({
      method: 'PATCH',
      path: expand('contentState', { courseId, contentId }),
      body: { reviewed },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  // ── gradebook ───────────────────────────────────────────────────────────

  async listGradeColumns(courseId: string, opts: ListOptions = {}): Promise<BbGradeColumn[]> {
    return this.paginate<BbGradeColumn>(expand('gradeColumns', { courseId }), {
      limit: opts.limit ?? 200,
      offset: opts.offset,
      query: {
        isExcludedFromCourseUserActivity: true,
        expand: 'associatedRubrics,collectExternalSubmissions',
        includeInvisible: false,
      },
    });
  }

  async getGradeColumn(courseId: string, columnId: string): Promise<BbGradeColumn> {
    return this.http.json<BbGradeColumn>({ path: expand('gradeColumn', { courseId, columnId }) });
  }

  /** The course's calculated final-grade column, when the tenant exposes one. */
  async getFinalGradeColumn(courseId: string): Promise<BbGradeColumn | null> {
    const res = await this.http.request({
      path: expand('finalGrade', { courseId }),
      allowNotFound: true,
      retries: 0,
    });
    if (res.status === 404) return null;
    return (await res.body.json()) as BbGradeColumn;
  }

  /**
   * Grades for one column. This is the reliable read: the course-wide
   * `gradebook/grades` list omits score fields on some tenants, whereas the
   * per-column endpoint returns `effectiveScore`/`displayGrade`/`status`.
   */
  async getColumnGrades(courseId: string, columnId: string, userId?: string): Promise<BbGrade[]> {
    const uid = userId ?? (await this.selfId());
    return this.paginate<BbGrade>(expand('columnGrades', { courseId, columnId }), {
      limit: 100,
      query: { userId: uid, expand: 'lastFeedbackAuthor,lastInstructorNotesAuthor' },
    });
  }

  /** Course-wide grade list for a user, with columns expanded. */
  async listGrades(courseId: string, userId?: string, opts: ListOptions = {}): Promise<BbGrade[]> {
    const uid = userId ?? (await this.selfId());
    return this.paginate<BbGrade>(expand('grades', { courseId }), {
      limit: opts.limit ?? 200,
      query: {
        userId: uid,
        expand: 'lastAttempt,attemptsLeft,submissionStatus,hasAttemptOrGradeFeedback,column',
        sort: 'column.position(asc)',
      },
    });
  }

  /** All grading schemas defined in a course. */
  async listGradeSchemas(courseId: string): Promise<BbGradeSchema[]> {
    return this.paginate<BbGradeSchema>(expand('gradeSchemas', { courseId }), { limit: 100 });
  }

  async getGradeSchema(courseId: string, schemaId: string): Promise<BbGradeSchema> {
    return this.http.json<BbGradeSchema>({ path: expand('gradeSchema', { courseId, schemaId }) });
  }

  /**
   * Due-date / time-limit exceptions granted to a student (extensions).
   *
   * Keyed by *membership* id, not user id. Take it from the course roster or
   * the membership record in `listCourses`.
   */
  async listDueDateExceptions(courseId: string, membershipId: string): Promise<unknown[]> {
    try {
      return await this.paginate(
        expand('gradebookExceptions', { courseId, membershipId }),
        { limit: 100 },
      );
    } catch (err) {
      log.debug(`No exceptions readable for ${courseId}/${membershipId}`, String(err));
      return [];
    }
  }



  // ── notifications and read state ────────────────────────────────────────

  /** Clears the "new grade" badge on a grade. */
  async markGradeSeen(courseId: string, columnId: string, gradeId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: expand('unreadGradeIndicator', { courseId, columnId, gradeId }),
      allowNotFound: true,
    });
  }

  /** Dismisses one course notification. */
  async dismissNotification(courseId: string, notificationId: string): Promise<void> {
    await this.http.request({
      method: 'DELETE',
      path: expand('courseNotification', { courseId, notificationId }),
      allowNotFound: true,
    });
  }

  /** Marks a conversation message read. */
  async markMessageRead(
    courseId: string,
    conversationId: string,
    messageId: string,
    read = true,
  ): Promise<unknown> {
    return this.http.json({
      method: 'PATCH',
      path: expand('conversationMessage', { courseId, conversationId, messageId }),
      body: { isRead: read },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  /** Per-user read and post counts for a forum. */
  async getForumUserCounts(courseId: string, forumId: string): Promise<unknown> {
    return this.http.json({ path: expand('forumUserCounts', { courseId, forumId }) });
  }

  /** Whether a forum permits anonymous posting. */
  async getForumAnonymity(courseId: string, forumId: string): Promise<unknown> {
    return this.http.json({ path: expand('forumAnonymous', { courseId, forumId }) });
  }

  /** One calendar entry by id. */
  async getCalendarEntry(courseId: string, entryId: string): Promise<BbCalendarItem> {
    return this.http.json<BbCalendarItem>({ path: expand('calendarEntry', { courseId, entryId }) });
  }

  /** Cloud storage providers connected to the account. */
  async listCloudStorages(): Promise<unknown> {
    return this.http.json({ path: expand('cloudStorages') });
  }

  /** Whether video capture is available on the instance. */
  async getVideoIntegration(): Promise<unknown> {
    return this.http.json({ path: expand('videoIntegration') });
  }

  // ── assessments ─────────────────────────────────────────────────────────

  /**
   * Graded questions for an assessment attempt: the points awarded per
   * question plus the nested question and the student's answer.
   *
   * This is the better of the two answer endpoints. The expand list mirrors
   * what the Ultra review screen requests, without which `question` comes back
   * as a bare id.
   */
  async listAttemptAnswerGrades(courseId: string, attemptId: string): Promise<BbAnswerGrade[]> {
    return this.paginate<BbAnswerGrade>(expand('attemptAnswerGrades', { courseId, attemptId }), {
      limit: 200,
      query: {
        expand:
          'questionAttempt.question,questionAttempt.question.usageCount,questionAttempt.question.sourceInfo,questionAttempt.answerCorrectness',
      },
    });
  }

  /**
   * Per-question records for an attempt, including each question and its
   * options.
   *
   * Reads the attempt with `expand=toolAttemptDetail`, because that is the only
   * request that returns the questions themselves. The dedicated
   * `assessment/answers` endpoint returns bare answer records with no
   * `question` and no `questionType`, and no `expand` value changes that, so
   * resolving "option 3" against a question is impossible from it. It is kept
   * as a fallback for tenants shaped differently.
   */
  async listAttemptAnswers(courseId: string, attemptId: string): Promise<BbQuestionAttempt[]> {
    try {
      const attempt = await this.http.json<BbAttempt>({
        path: expand('attempt', { courseId, attemptId }),
        query: { expand: 'toolAttemptDetail' },
      });
      const detail = attempt?.toolAttemptDetail ?? {};
      for (const value of Object.values(detail)) {
        const qa = (value as { questionAttempts?: BbQuestionAttempt[] })?.questionAttempts;
        if (Array.isArray(qa) && qa.length > 0) return qa;
      }
    } catch (err) {
      log.debug('toolAttemptDetail read failed; falling back', (err as Error).message);
    }

    return this.paginate<BbQuestionAttempt>(expand('attemptAnswers', { courseId, attemptId }), {
      limit: 200,
    });
  }

  /** Attempt history for one grade. */
  async listGradeAttempts(
    courseId: string,
    columnId: string,
    gradeId: string,
  ): Promise<BbGradeAttemptRow[]> {
    return this.paginate<BbGradeAttemptRow>(
      expand('gradeAttempts', { courseId, columnId, gradeId }),
      { limit: 100, query: { fields: 'id,status,attemptDate,exempt,overrideStatus' } },
    );
  }

  /**
   * Submission services on a column, such as originality reporting.
   * Worth checking before submitting, since it says whether the work will be
   * run through plagiarism detection.
   */
  async getSubmissionServices(courseId: string, columnId: string): Promise<BbSubmissionService[]> {
    const res = await this.http.json<{ submissionServices?: BbSubmissionService[] }>({
      path: expand('submissionServices', { courseId, columnId }),
    });
    return res?.submissionServices ?? [];
  }


  /**
   * Answers one question of an in-progress assessment attempt.
   *
   * `answerId` is the answer-record id from `listAttemptAnswers`, not the
   * question id. `givenAnswer` is shaped by the question type: a
   * `multipleanswer` question takes an array of booleans aligned by index with
   * `question.answers`, while free text takes a string.
   *
   * Only the minimal body is sent. The web UI echoes the entire question object
   * back on every keystroke; the server does not require it.
   */
  async saveQuizAnswer(
    courseId: string,
    attemptId: string,
    answerId: string,
    opts: { questionType: string; givenAnswer: unknown },
  ): Promise<BbQuestionAttempt> {
    return this.http.json<BbQuestionAttempt>({
      method: 'PATCH',
      path: expand('attemptAnswer', { courseId, attemptId, answerId }),
      body: { questionType: opts.questionType, givenAnswer: opts.givenAnswer },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  /**
   * Answers the question a user actually asks: has this been submitted?
   *
   * Getting this right needs care, because the obvious reads all mislead:
   *
   *  - `listColumnAttempts` is the instructor view. A student role receives an
   *    empty page rather than a 403, so an empty list is indistinguishable from
   *    "not submitted" and must never be presented as such.
   *  - `listGrades().status` reports `NEEDS_GRADING` on columns with no
   *    submission at all, so it is not a discriminator on its own.
   *  - `getColumnGrades` throws NOT_FOUND when no grade record exists yet,
   *    which *is* meaningful: no record means no attempt.
   *
   * So the authority is the grade record's attempt ids, with a missing record
   * treated as "not submitted".
   */
  async getSubmissionStatus(
    courseId: string,
    columnId: string,
    userId?: string,
  ): Promise<{
    submitted: boolean;
    attemptId?: string;
    status?: string;
    submittedAt?: string;
    late?: boolean;
    attemptCount?: number;
  }> {
    let grades: BbGrade[];
    try {
      grades = await this.getColumnGrades(courseId, columnId, userId);
    } catch (err) {
      const code = err instanceof BlackboardError ? err.code : '';
      // No grade record is the tenant's way of saying "never attempted".
      if (code === 'NOT_FOUND') return { submitted: false };
      throw err;
    }

    const grade = grades[0];
    if (!grade) return { submitted: false };

    const attemptId =
      grade.lastAttemptId ?? grade.firstAttemptId ?? grade.highestAttemptId ?? undefined;
    if (!attemptId) {
      return { submitted: false, status: grade.status ?? undefined };
    }

    // Read the attempt itself for the authoritative timestamp and receipt.
    let attempt: BbAttempt | undefined;
    try {
      attempt = await this.getAttempt(courseId, attemptId);
    } catch {
      /* the id is enough to know something was submitted */
    }

    let attemptCount: number | undefined;
    if (grade.id) {
      const rows = await this.listGradeAttempts(courseId, columnId, grade.id).catch(() => []);
      if (rows.length > 0) attemptCount = rows.length;
    }

    return {
      submitted: true,
      attemptId,
      status: attempt?.status ?? grade.status ?? undefined,
      submittedAt: attempt?.attemptReceipt?.submissionDate ?? attempt?.attemptDate ?? undefined,
      late: attempt?.attemptReceipt?.lateSubmission,
      attemptCount,
    };
  }

  // ── submission (writes) ─────────────────────────────────────────────────

  /**
   * Creates, or returns, the in-progress draft attempt for a gradebook column.
   *
   * Blackboard treats submitting as two steps: an attempt in `IN_PROGRESS`
   * holds the draft, and a later status change to `NEEDS_GRADING` submits it.
   * Calling this when a draft already exists returns that same attempt rather
   * than creating a duplicate, so it is safe to call more than once.
   *
   * `scoreProviderHandle` is read off the column rather than hardcoded: it
   * varies by assignment type, and sending the wrong one is rejected.
   */
  async createDraftAttempt(courseId: string, columnId: string): Promise<BbAttempt> {
    const column = await this.getGradeColumn(courseId, columnId);
    const handle = column.scoreProviderHandle ?? 'resource/x-bb-assessment';

    return this.http.json<BbAttempt>({
      method: 'POST',
      path: expand('columnAttempts', { courseId, columnId }),
      body: {
        stagedAttemptGrades: [],
        scoreProviderHandle: {
          name: handle,
          iconClass: 'test',
          contentHandlers: ['resource/x-bb-asmt-test-link'],
          needsGradingIcon: 'grades',
          needsReconcilingIcon: 'grades',
        },
        status: 'IN_PROGRESS',
        toolAttemptDetail: { [handle]: { type: 'Test' } },
      },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  /**
   * Writes text onto an attempt, either saving a draft or submitting it.
   *
   * `submit: false` leaves the attempt `IN_PROGRESS` and is reversible.
   * `submit: true` moves it to `NEEDS_GRADING`, which is what an instructor
   * sees as a submission, and is **not** reversible by this API.
   *
   * File attachments are not supported: `studentSubmissionFiles` is always sent
   * empty, because the upload flow has never been captured and guessing at it
   * risks a submission that looks complete but carries no work.
   */
  async writeAttempt(
    courseId: string,
    attemptId: string,
    opts: { text: string; submit: boolean; scoreProviderHandle?: string },
  ): Promise<BbAttempt> {
    const handle = opts.scoreProviderHandle ?? 'resource/x-bb-assessment';
    return this.http.json<BbAttempt>({
      method: 'PATCH',
      path: expand('attempt', { courseId, attemptId }),
      query: {
        saveBeforeSubmitAndPost: opts.submit,
        expand: 'toolAttemptDetail,attemptReceipt.lateSubmission',
      },
      body: {
        status: opts.submit ? 'NEEDS_GRADING' : 'IN_PROGRESS',
        toolAttemptDetail: { [handle]: { type: 'Test', scoreProviderHandle: handle } },
        studentSubmission: { rawText: opts.text },
        studentSubmissionFiles: [],
      },
      headers: { 'Content-Type': 'application/json' },
    });
  }


  /**
   * Submits an assessment attempt whose answers were already saved per
   * question.
   *
   * Distinct from `writeAttempt` because the contract differs: the query is
   * `autoSubmitted=false` rather than `saveBeforeSubmitAndPost=true`, and
   * `studentSubmission` is explicitly `null`, since the work lives in the
   * per-question answer records rather than in a text body.
   *
   * An auto-graded assessment comes back as `COMPLETED` with a score already
   * populated, so this is irreversible and immediately consequential.
   */
  async submitAssessmentAttempt(
    courseId: string,
    attemptId: string,
    opts: { scoreProviderHandle?: string } = {},
  ): Promise<BbAttempt> {
    const handle = opts.scoreProviderHandle ?? 'resource/x-bb-assessment';
    return this.http.json<BbAttempt>({
      method: 'PATCH',
      path: expand('attempt', { courseId, attemptId }),
      query: { autoSubmitted: false, expand: 'attemptReceipt.lateSubmission' },
      body: {
        toolAttemptDetail: { [handle]: { type: 'Test' } },
        status: 'NEEDS_GRADING',
        studentSubmission: null,
      },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  async getAttempt(courseId: string, attemptId: string): Promise<BbAttempt> {
    return this.http.json<BbAttempt>({ path: expand('attempt', { courseId, attemptId }) });
  }

  /**
   * Attempts on a gradebook column for one grade record.
   *
   * Two things make this endpoint easy to get wrong, and getting it wrong means
   * reporting submitted work as missing:
   *
   *  1. It needs `gradeId`. Without it the response carries no attempts at all.
   *  2. It does not use the usual `results` envelope. Attempts arrive under
   *     `lookup[gradeId]`, with no `paging`, so a generic paginator sees an
   *     empty body and yields `[]`.
   *
   * `gradeId` is resolved from the grade record when not supplied.
   */
  async listColumnAttempts(
    courseId: string,
    columnId: string,
    opts: ListOptions & { gradeId?: string; userId?: string } = {},
  ): Promise<BbAttempt[]> {
    let gradeId = opts.gradeId;
    if (!gradeId) {
      const grades = await this.getColumnGrades(courseId, columnId, opts.userId).catch(() => []);
      gradeId = grades[0]?.id;
    }
    if (!gradeId) return [];

    const res = await this.http.json<{
      lookup?: Record<string, BbAttempt[]>;
      results?: BbAttempt[];
    }>({
      path: expand('columnAttempts', { courseId, columnId }),
      query: { gradeId },
    });

    // Prefer the lookup bucket; fall back to `results` for tenants that use it.
    return res?.lookup?.[gradeId] ?? res?.results ?? [];
  }

  /** Files submitted with an attempt. */
  async listAttemptFiles(courseId: string, columnId: string, attemptId: string): Promise<BbAttemptFile[]> {
    return this.paginate<BbAttemptFile>(
      expand('attemptFiles', { courseId, columnId, attemptId }),
      { limit: 100 },
    );
  }

  attemptFileDownloadPath(courseId: string, columnId: string, attemptId: string, fileId: string): string {
    return expand('attemptFileDownload', { courseId, columnId, attemptId, fileId });
  }

  attachmentDownloadPath(courseId: string, contentId: string, attachmentId: string): string {
    return expand('contentAttachmentDownload', { courseId, contentId, attachmentId });
  }

  // ── announcements ───────────────────────────────────────────────────────

  async listCourseAnnouncements(courseId: string, opts: ListOptions = {}): Promise<BbAnnouncement[]> {
    const rows = await this.paginate<BbAnnouncement>(
      expand('courseAnnouncements', { courseId }),
      {
        limit: opts.limit ?? 25,
        offset: opts.offset,
        query: { sort: 'startDateRestriction(desc)' },
      },
    );
    const name = await this.courseName(courseId);
    return rows.map((a) => ({ ...a, courseId, _courseName: name }));
  }

  // ── calendar & deadlines ────────────────────────────────────────────────

  async listCalendarItems(opts: { since: string; until: string; courseId?: string } & ListOptions): Promise<BbCalendarItem[]> {
    const path = opts.courseId
      ? expand('courseCalendarItems', { courseId: opts.courseId })
      : expand('calendarItems');
    return this.paginate<BbCalendarItem>(path, {
      limit: opts.limit ?? 200,
      query: { since: opts.since, until: opts.until },
    });
  }

  /**
   * The Ultra to-do widget: overdue, due today, and upcoming in one call.
   * Buckets are flattened with `_bucket` set so callers can group them again.
   */
  async listTodo(opts: { since: string; until: string }): Promise<BbTodoItem[]> {
    const res = await this.http.json<BbTodoResponse>({
      path: expand('todoItems'),
      query: { since: opts.since, until: opts.until },
    });
    const tag = (rows: BbTodoItem[] | undefined, bucket: BbTodoItem['_bucket']): BbTodoItem[] =>
      (rows ?? []).map((r) => ({
        ...r,
        _bucket: bucket,
        _courseId: r.column?.courseId,
      }));
    return [
      ...tag(res?.overdueItems, 'overdue'),
      ...tag(res?.dueTodayItems, 'dueToday'),
      ...tag(res?.futureDueItems, 'upcoming'),
    ];
  }

  // ── messages ────────────────────────────────────────────────────────────

  async listConversations(courseId: string, opts: ListOptions = {}): Promise<BbConversation[]> {
    return this.paginate<BbConversation>(expand('conversations', { courseId }), opts);
  }

  async listConversationMessages(courseId: string, conversationId: string, opts: ListOptions = {}): Promise<BbConversationMessage[]> {
    return this.paginate<BbConversationMessage>(
      expand('conversationMessages', { courseId, conversationId }),
      opts,
    );
  }

  /** Unread conversation counts for every course at once. */
  async conversationCounts(): Promise<unknown> {
    return this.http.json({ path: expand('conversationCounts') });
  }

  async messagesSummary(): Promise<unknown> {
    return this.http.json({ path: expand('messagesSummary') });
  }

  // ── discussions ─────────────────────────────────────────────────────────

  async listForumMessages(courseId: string, forumId: string, opts: ListOptions = {}): Promise<BbForumMessage[]> {
    return this.paginate<BbForumMessage>(expand('forumMessages', { courseId, forumId }), opts);
  }

  async listForumReplies(courseId: string, forumId: string, messageId: string, opts: ListOptions = {}): Promise<BbForumMessage[]> {
    return this.paginate<BbForumMessage>(
      expand('forumMessageReplies', { courseId, forumId, messageId }),
      opts,
    );
  }

  // ── attendance ──────────────────────────────────────────────────────────

  async listAttendance(courseId: string, opts: ListOptions = {}): Promise<BbAttendanceRecord[]> {
    return this.paginate<BbAttendanceRecord>(expand('attendanceRecords', { courseId }), opts);
  }

  // ── activity stream ─────────────────────────────────────────────────────

  async getStream(opts: { forOverview?: boolean; flushCache?: boolean } = {}): Promise<BbStreamResponse> {
    return this.http.json<BbStreamResponse>({
      method: 'POST',
      path: expand('stream'),
      body: {
        providers: {},
        forOverview: opts.forOverview ?? false,
        retrieveOnly: true,
        flushCache: opts.flushCache ?? false,
      },
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      forceAllowWrite: true, // A POST that only reads the stream.
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

export function displayName(user: BbUser): string {
  const preferred = user.preferredDisplayName?.trim();

  // Some tenants ship the display-name *template* rather than a rendered value,
  // so this field arrives as the literal token "GIVEN_NAME". Treat an all-caps
  // underscore token as unset; a real name is never shaped like that, and the
  // given/family fields are populated in exactly these cases.
  const isUnresolvedTemplate = !!preferred && /^[A-Z][A-Z_]*$/.test(preferred);

  if (preferred && !isUnresolvedTemplate) return preferred;

  const parts = [user.givenName, user.familyName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return preferred ?? user.userName ?? user.id;
}

export function courseLabel(course: BbCourse | undefined): string {
  if (!course) return 'Unknown course';
  return course.displayName ?? course.name ?? course.courseId ?? course.id;
}

/** Handlers whose `contentDetail` marks them as containers of other items. */
export function isContainer(node: BbContent): boolean {
  if (node.hasChildren === true) return true;
  if (node.hasChildren === false) return false;
  const detail = node.contentHandler ? node.contentDetail?.[node.contentHandler] : undefined;
  if (detail && (detail.isFolder === true || detail.isLesson === true)) return true;
  return (
    node.contentHandler === 'resource/x-bb-folder' ||
    node.contentHandler === 'resource/x-bb-lesson'
  );
}

/** Pulls the file record out of a `resource/x-bb-file` content item. */
export function fileDetailOf(node: BbContent): BbFileDetail | null {
  const detail = node.contentHandler ? node.contentDetail?.[node.contentHandler] : undefined;
  const file = detail?.file as BbFileDetail | undefined;
  return file ?? null;
}
