/**
 * Domain types for the Blackboard Learn **Ultra internal API** (`/learn/api/v1`).
 *
 * Shapes verified against a live-tenant HAR capture. Note this API differs
 * substantially from the documented public REST API: `contentHandler` is a bare
 * string rather than an object, rich text arrives as `{rawText, displayText}`,
 * and `paging` carries `count`/`offset` rather than only a next-page link.
 *
 * Treat nearly every field as optional. Tenants disable features and
 * instructors leave things unset.
 */

/** Standard envelope for every list endpoint. */
export interface Paged<T> {
  results: T[];
  paging?: {
    limit?: number;
    offset?: number;
    count?: number;
    /** Empty string (not absent) when there is no further page. */
    nextPage?: string;
    previousPage?: string;
  };
  permissions?: Record<string, unknown> | null;
}

/** Blackboard's rich-text envelope. `displayText` is render-ready HTML. */
export interface BbText {
  rawText?: string;
  displayText?: string;
  webLocation?: string;
  fileLocation?: string;
}

// ── identity ──────────────────────────────────────────────────────────────

export interface BbUser {
  id: string;
  uuid?: string;
  userName?: string;
  studentId?: string;
  emailAddress?: string;
  givenName?: string;
  familyName?: string;
  middleName?: string;
  preferredDisplayName?: string;
  department?: string;
  locale?: string;
  systemRole?: string;
  systemRoles?: string[];
  insRoles?: string[];
  landingPage?: string;
  avatar?: { permanentUrl?: string; forceDownload?: boolean };
  createdDate?: string;
  lastModifiedAt?: string;
}

// ── courses ───────────────────────────────────────────────────────────────

export interface BbCourse {
  id: string;
  uuid?: string;
  /** Human-facing course code, e.g. "CS101.2.M.B_C2_123456". */
  courseId?: string;
  /** Short code shown in the UI. */
  displayId?: string;
  name?: string;
  /** Usually the nicest label to show a user. */
  displayName?: string;
  description?: string;
  termId?: string;
  term?: BbTerm;
  isAvailable?: boolean;
  isClosed?: boolean;
  isOrganization?: boolean;
  ultraStatus?: string;
  courseViewOption?: string;
  enrollmentType?: string;
  durationType?: string;
  paceType?: string;
  externalAccessUrl?: string;
  createdDate?: string;
  modifiedDate?: string;
  effectiveAvailability?: unknown;
  permissions?: Record<string, unknown>;
  locale?: unknown;
}

export interface BbTerm {
  id: string;
  name?: string;
  description?: BbText;
  isAvailable?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  durationType?: string;
  daysOfUse?: number;
}

export interface BbCourseRole {
  id?: string;
  identifier?: string;
  courseName?: string;
  roleBucket?: string;
  isActAsInstructor?: boolean;
  sortOrder?: number;
}

export interface BbMembership {
  id?: string;
  userId: string;
  courseId: string;
  /** Single-letter code, e.g. "S" (student), "P" (instructor). */
  role?: string;
  courseRole?: BbCourseRole;
  isAvailable?: boolean;
  enrollmentDate?: string;
  lastAccessDate?: string;
  modifiedDate?: string;
  /** True when the student has hidden the course from their own list. */
  userHasHidden?: boolean;
  courseCardColorIndex?: number;
  course?: BbCourse;
  user?: BbUser;
}

// ── content ───────────────────────────────────────────────────────────────

/** `contentHandler` values seen in the wild. LTI placements are open-ended. */
export type ContentHandler =
  | 'resource/x-bb-folder'
  | 'resource/x-bb-lesson'
  | 'resource/x-bb-file'
  | 'resource/x-bb-document'
  | 'resource/x-bb-assignment'
  | 'resource/x-bb-asmt-test-link'
  | 'resource/x-bb-externallink'
  | 'resource/x-bb-courselink'
  | 'resource/x-bb-forumlink'
  | 'resource/x-bb-toollink'
  | (string & {});

/** The file record inside `contentDetail['resource/x-bb-file'].file`. */
export interface BbFileDetail {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  /** Stable path, e.g. `/bbcswebdav/pid-…/xid-…`. Relative to the instance. */
  permanentUrl?: string;
  /** Inline-render variant; redirects through the document viewer for PDFs. */
  viewerUrl?: string;
  xid?: string;
  isMedia?: boolean;
  /** When true, append `xythos-download=true` to get bytes not a viewer page. */
  forceDownload?: boolean;
  existingFileReference?: string;
}

export interface BbContent {
  id: string;
  parentId?: string;
  courseId?: string;
  title?: string;
  description?: string;
  body?: BbText;
  /** A bare MIME-ish string, NOT an object (unlike the public API). */
  contentHandler?: ContentHandler;
  /** Keyed by the handler string; payload shape depends on the handler. */
  contentDetail?: Record<string, Record<string, unknown>>;
  position?: number;
  /** Epoch milliseconds on list endpoints, ISO string on some detail reads. */
  modifiedDate?: number | string;
  /** "Visible" | "Hidden" | "PartiallyVisible". */
  visibility?: string;
  state?: string;
  renderType?: string;
  iconUrl?: string;
  launchInNewWindow?: boolean;
  isReviewable?: boolean;
  isGroupContent?: boolean;
  inSequence?: boolean;
  isPrimaryLearningObject?: boolean;
  ancestorLessonId?: string | null;
  dueDateExceptionType?: string;
  permissions?: Record<string, unknown>;
  /** Present on some tenants; otherwise infer from the handler. */
  hasChildren?: boolean;
  hasGradebookColumns?: boolean;

  // ── fields this client injects; never returned by Blackboard ──
  /** The course the item was fetched from. */
  _courseId?: string;
  /** Breadcrumb built during a tree walk, e.g. "Week 1 / Readings / paper.pdf". */
  _path?: string;
  /** Depth in the walked tree, 0 for top-level items. */
  _depth?: number;
}

/** Attachment record from `contents/{id}/attachments`. */
export interface BbAttachment {
  id: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

// ── gradebook ─────────────────────────────────────────────────────────────

export interface BbGradeColumn {
  id: string;
  courseId?: string;
  columnName?: string;
  /** Falls back through localisation; prefer this for display. */
  effectiveColumnName?: string;
  localizedColumnName?: { languageKey?: string; bundle?: string };
  description?: BbText;
  possible?: number;
  position?: number;
  /** "Manual" | "Attempt" | "Calculated" … */
  calculationType?: string;
  multipleAttempts?: number;
  visible?: boolean;
  visibleInBook?: boolean;
  scorable?: boolean;
  gradesReleased?: boolean;
  deleted?: boolean;
  externalGrade?: boolean;
  userCreatedColumn?: boolean;
  anonymousGrading?: boolean;
  hasAnonymousSubmissions?: boolean;
  permanentAnonymous?: boolean;
  hasRubricAssociations?: boolean;
  peerGrading?: boolean;
  enforceDueDate?: boolean;
  isAttemptBased?: boolean;
  isFormative?: boolean;
  gradeScoreDesignation?: string;
  gradingSchemaId?: string;
  gradebookCategoryId?: string;
  gradebookCategory?: { id?: string; title?: string } | null;
  aggregationModel?: string;
  scoreProviderHandle?: string;
  /** Set when the column is backed by a content item (assignment/test). */
  contentId?: string;
  linkId?: string;
  dueDate?: string;
  itemsCount?: number;
  /** MathML weighting formula on calculated columns such as the final grade. */
  calculatedFormula?: { formula?: string; isTotalCalculation?: boolean; aliases?: unknown };
  learningOutcome?: unknown;
  ltiDomainId?: string | null;
}

export interface BbDisplayGrade {
  score?: number;
  possible?: number;
  text?: string;
  scaleType?: string;
  isOverride?: boolean;
  requiresSchemaKnowledgeToDisplay?: boolean;
}

/** A grade cell, from `columns/{id}/grades?userId=` or `gradebook/grades`. */
export interface BbGrade {
  id?: string;
  userId?: string;
  courseId?: string;
  columnId?: string;
  columnUrl?: string;
  /** Expanded column, when requested. */
  column?: BbGradeColumn;
  /** "GRADED" | "NEEDS_GRADING" | "NO_STATUS" … */
  status?: string;
  displayGrade?: BbDisplayGrade;
  /** Authoritative numeric score after overrides and exclusions. */
  effectiveScore?: number;
  manualScore?: number;
  manualGrade?: string;
  manualStatus?: string;
  pointsPossible?: number;
  averageScore?: number;
  gradeScoreDesignation?: string;
  isExempt?: boolean;
  isCorrupt?: boolean;
  isCalculatedColumnGrade?: boolean;
  hasBeenViewedByStudent?: boolean;
  hasAllAttemptsExcluded?: boolean;
  studentReviewedTimestamp?: string | null;
  lastOverrideDate?: string;
  firstAttemptId?: string | null;
  lastAttemptId?: string | null;
  highestAttemptId?: string | null;
  lowestAttemptId?: string | null;
  submissionStatus?: { status?: string; actionCount?: number | null };
  version?: number;
}

/** File submitted with an attempt. */
export interface BbAttemptFile {
  id?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  /** Download path, when the tenant supplies one inline. */
  permanentUrl?: string;
  viewerUrl?: string;
}

export interface BbAttempt {
  id: string;
  userId?: string;
  courseId?: string;
  gradeId?: string;
  groupAttemptId?: string;
  /** "NEEDS_GRADING" | "GRADED" | "IN_PROGRESS" … */
  status?: string;
  displayGrade?: BbDisplayGrade;
  /** The student's typed submission. */
  studentSubmission?: BbText;
  studentSubmissionFiles?: BbAttemptFile[];
  /** Instructor feedback on the attempt. */
  feedbackToUser?: BbText;
  exempt?: boolean;
  override?: boolean;
  overrideStatus?: string;
  readyToPost?: boolean;
  submissionHasFilePartsWithErrors?: boolean;
  attemptDate?: string;
  creationDate?: string;
  modifiedDate?: string;
  attemptFirstGradedDate?: string;
  attemptLastGradedDate?: string;
  attemptReceipt?: BbAttemptReceipt;
  /**
   * Tool-specific payload, keyed by score provider handle. For an assessment
   * this is where the questions live, under `questionAttempts`, and it is
   * returned only when requested with `expand=toolAttemptDetail`.
   */
  toolAttemptDetail?: Record<
    string,
    { questionAttempts?: BbQuestionAttempt[]; assessment?: unknown; possiblePoints?: number; [k: string]: unknown }
  >;
  permissions?: Record<string, boolean>;
}

// ── announcements ─────────────────────────────────────────────────────────

export interface BbAnnouncement {
  id: string;
  courseId?: string;
  title?: string;
  body?: BbText;
  type?: string;
  creatorUserId?: string;
  createdDate?: string;
  modifiedDate?: string;
  isDraft?: boolean;
  permanent?: boolean;
  pushNotify?: boolean;
  readTracking?: boolean;
  readStatus?: { isRead?: boolean; updateDate?: string; firstReadDate?: string };
  startDateRestriction?: string | null;
  endDateRestriction?: string | null;
  position?: number;

  /** Injected by this client for cross-course listings. */
  _courseName?: string;
}

// ── calendar & deadlines ──────────────────────────────────────────────────

export interface BbCalendarItem {
  id?: string;
  itemSourceId?: string;
  /** e.g. "blackboard.data.calendar.CalendarEntry" or a gradebook column type. */
  itemSourceType?: string;
  calendarId?: string;
  calendarNameLocalizable?: { rawValue?: string };
  title?: string;
  description?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  modifiedDate?: string;
  color?: string;
  visibility?: string;
  userCreated?: boolean;
  createdByUser?: string;

  /** Injected by this client. */
  _courseName?: string;
}

/** One entry in the Ultra to-do widget. */
export interface BbTodoItem {
  title?: string;
  dueDate?: string;
  column?: BbGradeColumn;
  contentVisibility?: string;
  isLateAttemptCreationDisallowed?: boolean;

  /** Injected: which bucket the item came from. */
  _bucket?: 'overdue' | 'dueToday' | 'upcoming';
  _courseId?: string;
  _courseName?: string;
}

export interface BbTodoResponse {
  overdueItems?: BbTodoItem[];
  dueTodayItems?: BbTodoItem[];
  futureDueItems?: BbTodoItem[];
}

// ── messages & discussions ────────────────────────────────────────────────

export interface BbConversation {
  id: string;
  courseId?: string;
  subject?: string;
  title?: string;
  createdDate?: string;
  modifiedDate?: string;
  messageCount?: number;
  unreadCount?: number;
  lastMessagePreview?: string;
}

export interface BbConversationMessage {
  id: string;
  conversationId?: string;
  body?: BbText;
  authorId?: string;
  createdDate?: string;
  isRead?: boolean;
}

export interface BbForumMessage {
  id: string;
  forumId?: string;
  parentId?: string;
  subject?: string;
  body?: BbText;
  userId?: string;
  createdDate?: string;
  modifiedDate?: string;
  replyCount?: number;
  isRead?: boolean;
  isAnonymous?: boolean;
}

// ── attendance ────────────────────────────────────────────────────────────

export interface BbAttendanceRecord {
  id?: string;
  courseId?: string;
  userId?: string;
  meetingId?: string;
  /** "Present" | "Absent" | "Late" | "Excused". */
  status?: string;
  date?: string;
}

// ── activity stream ───────────────────────────────────────────────────────

/** The stream endpoint uses `sv_`/`sx_`/`sp_` prefixes rather than plain names. */
export interface BbStreamResponse {
  sv_streamEntries?: BbStreamEntry[];
  sv_deletedIds?: string[];
  sv_extras?: {
    sx_users?: BbUser[];
    sx_courses?: BbCourse[];
    sx_filters?: unknown[];
    sx_filter_links?: unknown[];
  };
  sv_now?: number;
  sv_moreData?: boolean;
  sv_providers?: Array<{ sp_provider?: string; sp_newest?: number; sp_oldest?: number }>;
}

export interface BbStreamEntry {
  se_id?: string;
  se_courseId?: string;
  se_context?: string;
  se_itemTitle?: string;
  se_details?: Record<string, unknown>;
  se_timestamp?: number;
  se_userId?: string;
  se_provider?: string;
  se_read?: boolean;
  [k: string]: unknown;
}

// ── grading schemas ───────────────────────────────────────────────────────

/**
 * A grading schema maps numeric percentages onto displayed grades, which is
 * how a raw score becomes "B+" or "Pass". Courses can define several.
 */
export interface BbGradeSchema {
  id: string;
  courseId?: string;
  title?: string;
  description?: BbText;
  /** "Score" | "Percentage" | "Letter" | "CompleteIncomplete" | "Text" ... */
  scaleType?: string;
  isNumeric?: boolean;
  /** Ordered bands, highest first on most tenants. */
  symbols?: Array<{
    /** Displayed grade, e.g. "B+". */
    text?: string;
    /** Inclusive lower bound as a percentage. */
    lowerBound?: number;
    /** Exclusive upper bound as a percentage. */
    upperBound?: number;
    /** Value written back when an instructor picks this symbol. */
    absoluteValue?: number;
  }>;
}


// ── submission ────────────────────────────────────────────────────────────

/**
 * Proof that Blackboard accepted a submission.
 *
 * `receiptId` is the confirmation number a student sees after submitting, and
 * is the only durable evidence the submission landed, so it is always surfaced.
 */
export interface BbAttemptReceipt {
  receiptId?: string;
  submissionDate?: string;
  submissionTotalSize?: number;
  /** "MANUALLY_SUBMITTED" for a student submission. */
  submissionType?: string;
  /** True when Blackboard considers this past the due date. */
  lateSubmission?: boolean;
  [k: string]: unknown;
}

// ── assessments and submission services ───────────────────────────────────

/**
 * A submission service attached to a gradebook column, such as originality
 * reporting. Shape confirmed against a live tenant.
 */
export interface BbSubmissionService {
  uniqueHandle?: string;
  displayName?: string;
  available?: boolean;
  capabilities?: {
    OriginalityReport?: { enabled?: boolean; default?: boolean };
    [k: string]: unknown;
  };
}

/** Compact attempt row from the per-grade attempt history. */
export interface BbGradeAttemptRow {
  id?: string;
  status?: string;
  attemptDate?: string;
  exempt?: boolean;
  overrideStatus?: string;
}

/**
 * One answer option offered by a question.
 */
export interface BbAnswerOption {
  id?: string;
  answerText?: BbText;
  positionLocked?: boolean;
}

/**
 * A question inside an assessment. Shape verified against a completed
 * 25-question attempt on a live tenant.
 */
export interface BbAssessmentQuestion {
  id?: string;
  /** e.g. "multipleanswer", "multiplechoice", "essay", "truefalse". */
  questionType?: string;
  questionText?: BbText;
  title?: string | null;
  points?: number;
  position?: number;
  answers?: BbAnswerOption[];
  answersCount?: number;
  singleCorrectAnswer?: boolean;
  answerSelectionLimit?: number;
  allowPartialCredit?: boolean;
  extraCredit?: boolean;
  isAutoGraded?: boolean;
  showAnswersInRandomOrder?: boolean;
  correctResponseFeedback?: BbText;
  incorrectResponseFeedback?: BbText;
  instructorNotes?: BbText;
  /** Present only when requested via expand. */
  sourceInfo?: { id?: string; name?: string; type?: string };
  usageCount?: number;
}

/**
 * The student's attempt at one question.
 *
 * `givenAnswer` is deliberately `unknown`: its type depends on the question
 * type. A `multipleanswer` question returns an array of booleans aligned by
 * index with `question.answers`, whereas free text returns a string.
 *
 * The `is*Visible` flags are what the tenant permits the student to see after
 * submitting. They must be honoured rather than assumed true: a course can post
 * scores while withholding which answers were correct.
 */
export interface BbQuestionAttempt {
  id?: string;
  attemptId?: string;
  questionId?: string;
  questionType?: string;
  attemptStatus?: string;
  givenAnswer?: unknown;
  order?: unknown[];
  lookupOrder?: unknown[];
  question?: BbAssessmentQuestion;
  visibleQuestionNumber?: number;
  isFeedbackVisible?: boolean;
  isCorrectAnswersVisible?: boolean;
  isScoreVisible?: boolean;
  isResultVisible?: boolean;
  saveTimes?: Array<{ date?: string; blankResponseSaved?: boolean }>;
  permissions?: { editGrades?: boolean; editGivenAnswers?: boolean };
}

/** A graded question: the points awarded, plus the attempt it grades. */
export interface BbAnswerGrade {
  points?: number;
  questionAttempt?: BbQuestionAttempt;
}
