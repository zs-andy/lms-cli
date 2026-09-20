import { htmlToText } from './extract.js';
import type { BbContent, BbText } from '../client/types.js';

/**
 * Normalises an assignment or test brief out of a content item.
 *
 * The information a student needs before starting work is buried several levels
 * inside `contentDetail`, under a key named after the content handler, and none
 * of it is reachable from `body`, which is empty on these items. Finding it
 * otherwise means already knowing the shape:
 *
 *   contentDetail['resource/x-bb-asmt-test-link']
 *     .test.assessment.instructions.rawText
 *     .test.deploymentSettings.{allowTextSubmission, allowFileSubmission, ...}
 *     .test.gradingColumn.{dueDate, possible}
 *
 * Verified against a live tenant. `deploymentSettings.restrictLocation` is
 * deliberately not surfaced: it contains the viewer's own IP address, which is
 * not information this package should be handing around.
 */

export interface AssignmentBrief {
  title?: string;
  /** Render-ready HTML, when the item has instructions. */
  instructionsHtml?: string;
  /** The same instructions as plain text. */
  instructionsText?: string;
  /** URLs found in the instructions. Often the assignment *is* a repo link. */
  links: string[];
  dueDate?: string;
  pointsPossible?: number;
  /** Whether a text body may be submitted. */
  allowsText?: boolean;
  /** Whether files may be attached. */
  allowsFiles?: boolean;
  /**
   * Attempts permitted. Blackboard uses `-1` (and sometimes `0`) as the
   * sentinel for unlimited, which is meaningless to a reader, so that is
   * normalised to `'unlimited'`.
   */
  attemptsAllowed?: number | 'unlimited';
  dueDateEnforced?: boolean;
  /** True when a late attempt cannot be started at all. */
  lateAttemptsBlocked?: boolean;
  /** Present when the assessment is timed. */
  timer?: string;
  /** Conditions worth warning a student about before they start. */
  requiresPassword?: boolean;
  requiresSecureBrowser?: boolean;
  requiresWebcam?: boolean;
  backtrackingProhibited?: boolean;
  questionsRandomised?: boolean;
  /** What the tenant will reveal after submitting. */
  showsScore?: boolean;
  showsCorrectAnswers?: boolean;
  /** The handler the brief was read from, for diagnostics. */
  handler?: string;
}

function textOf(t: unknown): { html?: string; text?: string } {
  if (!t || typeof t !== 'object') return {};
  const bb = t as BbText;
  const html = bb.displayText || bb.rawText || '';
  if (!html.trim()) return {};
  return { html, text: htmlToText(html) };
}

/** Extracts http(s) URLs from text, de-duplicated and in order. */
export function extractLinks(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Trailing punctuation is almost never part of the URL in prose.
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Blackboard signals "unlimited attempts" with -1, and sometimes 0. */
function normaliseAttempts(n: number | undefined): number | 'unlimited' | undefined {
  if (n === undefined) return undefined;
  return n <= 0 ? 'unlimited' : n;
}

/**
 * Reads the brief off a content item, or returns null when the item is not an
 * assignment or test.
 */
export function assignmentBriefOf(item: BbContent): AssignmentBrief | null {
  const handler = item.contentHandler;
  const detail = handler ? item.contentDetail?.[handler] : undefined;
  if (!detail) return null;

  // Assignments and tests nest everything under `test`; some tenants place the
  // same fields directly on the detail object.
  const test = (detail.test ?? detail) as Record<string, unknown>;
  const assessment = (test.assessment ?? {}) as Record<string, unknown>;
  const settings = (test.deploymentSettings ?? {}) as Record<string, unknown>;
  const column = (test.gradingColumn ?? {}) as Record<string, unknown>;

  const instr = textOf(assessment.instructions);
  const body = textOf(item.body);

  // Fall back to the item body when the assessment carries no instructions.
  const html = instr.html ?? body.html;
  const plain = instr.text ?? body.text;

  const brief: AssignmentBrief = {
    title: str(assessment.title) ?? item.title,
    instructionsHtml: html,
    instructionsText: plain,
    links: extractLinks(plain),
    dueDate: str(column.dueDate),
    pointsPossible: num(column.possible),
    allowsText: bool(settings.allowTextSubmission),
    allowsFiles: bool(settings.allowFileSubmission),
    attemptsAllowed: normaliseAttempts(num(settings.attemptCount)),
    dueDateEnforced: bool(settings.isDueDateEnforced) ?? bool(column.enforceDueDate),
    lateAttemptsBlocked: bool(settings.isLateAttemptCreationDisallowed),
    timer: str(settings.timerCompletion),
    requiresPassword: bool(settings.isPasswordRequired),
    requiresSecureBrowser: bool(settings.isSecureBrowserRequiredToTake),
    requiresWebcam: bool(settings.isWebcamRequired),
    backtrackingProhibited: bool(settings.isBacktrackingProhibited),
    questionsRandomised: bool(settings.isRandomizationOfQuestionsRequired),
    showsScore: bool(settings.isScoreShown),
    showsCorrectAnswers: bool(settings.isCorrectAnswerShown),
    handler,
  };

  // An item with nothing useful is not a brief.
  const informative =
    brief.instructionsText ||
    brief.dueDate !== undefined ||
    brief.pointsPossible !== undefined ||
    brief.allowsText !== undefined ||
    brief.links.length > 0;
  return informative ? brief : null;
}

/**
 * Plain text from any Blackboard rich-text field.
 *
 * `studentSubmission` and friends are `{rawText, displayText}` objects, so the
 * obvious `String(...)` yields `[object Object]`. This is the accessor to reach
 * for instead.
 */
export function plainText(field: BbText | string | undefined | null): string {
  if (!field) return '';
  if (typeof field === 'string') return htmlToText(field);
  return htmlToText(field.displayText || field.rawText || '');
}
