import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section, relativeDue } from './helpers.js';
import {
  courseLabel, type BbGrade, type BbGradeColumn, type BbGradeSchema, type Paged,
} from '../client/index.js';
import { htmlToText } from '../lib/extract.js';
import { BlackboardError } from '../lib/errors.js';
import { encodeAnswer, describeOptions, type LooseAnswer } from '../lib/answers.js';
import { fmtBytes } from '../lib/files.js';

/** Best display string for a grade cell, across the several shapes it takes. */
function gradeText(g: BbGrade, possible: number | undefined): string {
  const score = g.effectiveScore ?? g.manualScore ?? g.displayGrade?.score;
  const max = possible ?? g.pointsPossible ?? g.displayGrade?.possible;
  if (g.isExempt) return 'exempt';
  if (score === undefined) {
    if (g.status === 'NEEDS_GRADING') return 'awaiting grade';
    return g.displayGrade?.text ?? g.manualGrade ?? '-';
  }
  const pct = max ? ` (${Math.round((score / max) * 100)}%)` : '';
  return max !== undefined ? `${score}/${max}${pct}` : String(score);
}

function columnName(c: BbGradeColumn | undefined): string {
  return c?.effectiveColumnName ?? c?.columnName ?? c?.id ?? '';
}

/**
 * Maps a score onto the course's displayed grade (e.g. "B+").
 *
 * Blackboard stores the numeric score and the schema separately, so a raw
 * score alone cannot tell a student whether they passed. The same 65 is a
 * distinction on one schema and a fail on another.
 */
function letterGrade(
  schema: BbGradeSchema | undefined,
  score: number | undefined,
  possible: number | undefined,
): string | undefined {
  if (!schema?.symbols?.length || score === undefined || !possible) return undefined;
  const pct = (score / possible) * 100;
  for (const sym of schema.symbols) {
    const lo = sym.lowerBound;
    const hi = sym.upperBound;
    if (lo === undefined && hi === undefined) continue;
    const aboveLo = lo === undefined || pct >= lo;
    const belowHi = hi === undefined || pct < hi;
    if (aboveLo && belowHi) return sym.text;
  }
  return undefined;
}


/** Writes are off by default; every write tool goes through this. */
function assertWritesEnabled(allowed: boolean): void {
  if (!allowed) {
    throw new BlackboardError('FORBIDDEN', 'Writes are disabled on this server.', {
      hint: 'This server is read-only unless BLACKBOARD_MCP_ALLOW_WRITES=1 is set in its environment. Submitting coursework is deliberately opt-in.',
    });
  }
}

export function registerGradeTools(server: McpServer): void {
  server.registerTool(
    'bb_list_grades',
    {
      title: 'List Blackboard grades',
      description:
        'Lists grades for one course, or across every enrolled course when courseId is omitted. Shows each graded item, the score out of its total, and its status. Cross-course mode uses Blackboard\'s batch API so it costs roughly one request rather than one per course.',
      inputSchema: {
        courseId: z
          .string()
          .optional()
          .describe('Course id, e.g. "_12345_1". Omit for every enrolled course.'),
        gradedOnly: z.boolean().optional().describe('Hide items with no score yet. Default false.'),
        maxCourses: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('Cap courses in cross-course mode. Default 15.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_grades', async (args) => {
      const client = await getClient();
      const userId = await client.selfId();

      // ── single course ──
      if (args.courseId) {
        const [label, columns, grades] = await Promise.all([
          client.courseName(args.courseId),
          client.listGradeColumns(args.courseId),
          client.listGrades(args.courseId, userId),
        ]);
        const byId = new Map(columns.map((c) => [c.id, c]));

        let rows = grades.map((g) => {
          const col = g.column ?? (g.columnId ? byId.get(g.columnId) : undefined);
          return {
            item: clip(columnName(col) || g.columnId, 50),
            grade: gradeText(g, col?.possible),
            status: g.status ?? g.submissionStatus?.status,
            due: col?.dueDate ? `${when(col.dueDate)} (${relativeDue(col.dueDate)})` : undefined,
            columnId: g.columnId,
            viewed: g.hasBeenViewedByStudent === false ? 'new' : undefined,
          };
        });
        if (args.gradedOnly) rows = rows.filter((r) => r.grade !== '-' && r.grade !== 'awaiting grade');

        // Columns with no grade row at all still matter. They are upcoming work.
        const seen = new Set(grades.map((g) => g.columnId));
        const ungraded = columns
          .filter((c) => !seen.has(c.id) && c.scorable !== false && !c.calculatedFormula)
          .map((c) => ({
            item: clip(columnName(c), 50),
            grade: '-',
            status: 'no submission',
            due: c.dueDate ? `${when(c.dueDate)} (${relativeDue(c.dueDate)})` : undefined,
            columnId: c.id,
            viewed: undefined,
          }));

        const final = await client.getFinalGradeColumn(args.courseId).catch(() => null);
        const finalNote = final
          ? `\n**Final grade column:** ${columnName(final)}${
              final.possible ? ` (out of ${final.possible})` : ''
            }${final.calculatedFormula ? '. Calculated/weighted' : ''}\n`
          : '';

        return text(
          [
            `# Grades: ${label}`,
            finalNote,
            table(args.gradedOnly ? rows : [...rows, ...ungraded]),
            '',
            '_Use `bb_get_grade_detail` with a columnId for feedback, attempts and submissions._',
          ].join('\n'),
        );
      }

      // ── all courses, via the batch fan-out ──
      const memberships = (await client.listCourses({ availableOnly: true })).slice(
        0,
        args.maxCourses ?? 15,
      );
      const labels = new Map<string, string>();
      for (const m of memberships) labels.set(m.course?.id ?? m.courseId, courseLabel(m.course));

      const requests = memberships.map((m) => ({
        method: 'GET' as const,
        relativeUrl: `v1/courses/${m.course?.id ?? m.courseId}/gradebook/grades?userId=${userId}&limit=100&expand=column,submissionStatus`,
      }));
      const responses = await client.batch<Paged<BbGrade>>(requests);

      const rows: Array<Record<string, string | number | undefined>> = [];
      const failures: string[] = [];

      responses.forEach((res, i) => {
        const courseId = memberships[i]?.course?.id ?? memberships[i]?.courseId ?? '?';
        const label = labels.get(courseId) ?? courseId;
        const status = res.status ?? res.code ?? 200;
        if (status >= 400 || !res.body) {
          failures.push(`${label} (HTTP ${status})`);
          return;
        }
        for (const g of res.body.results ?? []) {
          const col = g.column;
          const grade = gradeText(g, col?.possible);
          if (args.gradedOnly && (grade === '-' || grade === 'awaiting grade')) continue;
          rows.push({
            course: clip(label, 28),
            item: clip(columnName(col) || g.columnId, 40),
            grade,
            status: g.status ?? g.submissionStatus?.status,
            due: col?.dueDate ? relativeDue(col.dueDate) : undefined,
            courseId,
            columnId: g.columnId,
          });
        }
      });

      return text(
        [
          `# Grades across ${memberships.length - failures.length} course(s)`,
          '',
          table(rows),
          failures.length ? `\n_Could not read: ${failures.join('; ')}_` : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_get_grade_detail',
    {
      title: 'Get grade detail with feedback',
      description:
        'Everything about one gradebook item: the score, rubric/points, due date, every attempt with its timestamp and status, the student\'s submitted text, and the instructor\'s written feedback. This is where feedback lives. The grade list does not carry it.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id from bb_list_grades.'),
        includeAttempts: z.boolean().optional().describe('Fetch attempt detail. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_get_grade_detail', async ({ courseId, columnId, includeAttempts }) => {
      const client = await getClient();
      const [label, column, grades] = await Promise.all([
        client.courseName(courseId),
        client.getGradeColumn(courseId, columnId),
        client.getColumnGrades(courseId, columnId),
      ]);

      const grade = grades[0];

      // The schema turns the raw score into the grade the student actually sees.
      let schema: BbGradeSchema | undefined;
      if (column.gradingSchemaId) {
        schema = await client
          .getGradeSchema(courseId, column.gradingSchemaId)
          .catch(() => undefined);
      }
      const letter = letterGrade(
        schema,
        grade?.effectiveScore ?? grade?.manualScore ?? grade?.displayGrade?.score,
        column.possible,
      );
      const head = table([
        { field: 'item', value: columnName(column) },
        { field: 'course', value: label },
        { field: 'grade', value: grade ? gradeText(grade, column.possible) : 'no grade record' },
        { field: 'letter grade', value: letter },
        { field: 'points possible', value: column.possible },
        { field: 'grading schema', value: schema?.title },
        { field: 'status', value: grade?.status },
        { field: 'due', value: column.dueDate ? `${when(column.dueDate)} (${relativeDue(column.dueDate)})` : undefined },
        { field: 'attempts allowed', value: column.multipleAttempts },
        { field: 'grading type', value: column.calculationType },
        { field: 'rubric attached', value: column.hasRubricAssociations ? 'yes' : undefined },
        { field: 'anonymous', value: column.anonymousGrading ? 'yes' : undefined },
        { field: 'released', value: column.gradesReleased === false ? 'not yet' : 'yes' },
        { field: 'override', value: grade?.displayGrade?.isOverride ? 'yes' : undefined },
        { field: 'last override', value: when(grade?.lastOverrideDate) },
        { field: 'contentId', value: column.contentId },
      ]);

      const description = column.description?.displayText
        ? htmlToText(column.description.displayText)
        : column.description?.rawText ?? '';

      // Attempt ids come off the grade record; the attempt endpoint carries the
      // submission text and the instructor's feedback.
      let attemptsBody = '';
      if (includeAttempts !== false) {
        const ids = [
          ...new Set(
            [grade?.lastAttemptId, grade?.firstAttemptId, grade?.highestAttemptId, grade?.lowestAttemptId].filter(
              (v): v is string => typeof v === 'string' && v.length > 0,
            ),
          ),
        ];

        const blocks: string[] = [];
        for (const id of ids.slice(0, 5)) {
          try {
            const a = await client.getAttempt(courseId, id);
            const submitted = a.studentSubmission?.displayText
              ? htmlToText(a.studentSubmission.displayText)
              : a.studentSubmission?.rawText ?? '';
            const feedback = a.feedbackToUser?.displayText
              ? htmlToText(a.feedbackToUser.displayText)
              : a.feedbackToUser?.rawText ?? '';
            const files = a.studentSubmissionFiles ?? [];

            blocks.push(
              [
                `### Attempt ${id}`,
                '',
                table([
                  { field: 'submitted', value: when(a.attemptDate) },
                  { field: 'status', value: a.status },
                  { field: 'grade', value: a.displayGrade?.score },
                  { field: 'graded', value: when(a.attemptLastGradedDate) },
                  { field: 'exempt', value: a.exempt ? 'yes' : undefined },
                  {
                    field: 'files',
                    value: files.length
                      ? files
                          .map((f) => `${f.fileName ?? f.id} (${fmtBytes(f.fileSize ?? 0)})`)
                          .join(', ')
                      : undefined,
                  },
                  { field: 'receipt', value: a.attemptReceipt?.receiptId },
                ]),
                submitted ? `\n**Submitted text:**\n\n${clip(submitted, 2000)}` : '',
                feedback ? `\n**Instructor feedback:**\n\n${clip(feedback, 2000)}` : '',
                files.length ? `\n_Use \`bb_download_submission\` with attemptId=${id} to fetch the files._` : '',
              ].join('\n'),
            );
          } catch (err) {
            blocks.push(`### Attempt ${id}\n\n_Could not read: ${(err as Error).message}_`);
          }
        }

        if (blocks.length === 0) {
          // Do not fall back to listColumnAttempts here. That is the instructor
          // view, and a student role gets an empty page rather than a 403, so
          // its empty result would render as "no attempts" for work that was in
          // fact submitted. Ask the authoritative source instead.
          const status = await client
            .getSubmissionStatus(courseId, columnId)
            .catch(() => ({ submitted: false }) as Awaited<ReturnType<typeof client.getSubmissionStatus>>);
          attemptsBody = status.submitted
            ? table([
                { field: 'submitted', value: 'yes' },
                { field: 'attemptId', value: status.attemptId },
                { field: 'status', value: status.status },
                { field: 'submitted at', value: when(status.submittedAt) },
                { field: 'late', value: status.late === true ? 'YES' : undefined },
              ])
            : '_No submission on record for this item._';
        } else {
          attemptsBody = blocks.join('\n\n');
        }
      }

      // Originality reporting changes what submitting means, so surface it
      // here rather than making the user guess.
      let services = '';
      try {
        const svc = await client.getSubmissionServices(courseId, columnId);
        if (svc.length > 0) {
          services = table(
            svc.map((v) => ({
              service: v.displayName ?? v.uniqueHandle,
              available: v.available === false ? 'no' : 'yes',
              originalityReport:
                v.capabilities?.OriginalityReport?.enabled === true ? 'enabled' : undefined,
            })),
          );
        }
      } catch {
        /* not configured on this column */
      }

      // Full attempt history, which the grade record alone does not give.
      let history = '';
      if (grade?.id) {
        try {
          const rows = await client.listGradeAttempts(courseId, columnId, grade.id);
          if (rows.length > 0) {
            history = table(
              rows.map((r) => ({
                attemptId: r.id,
                status: r.status,
                submitted: when(r.attemptDate),
                exempt: r.exempt ? 'yes' : undefined,
              })),
            );
          }
        } catch {
          /* history unavailable */
        }
      }

      return text(
        [
          `# ${columnName(column)}`,
          '',
          head,
          section('Instructions', clip(description, 3000)),
          section('Submission services', services),
          section('Attempt history', history),
          section('Attempts', attemptsBody),
          attemptsBody || history
            ? '\n_If this is a quiz, `bb_review_quiz_attempt` reads it back question by question._'
            : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_grade_summary',
    {
      title: 'Summarise grade standing per course',
      description:
        'Computes, per course, how many items are graded, the running points total, and the average percentage. Use this for "how am I doing overall?" questions rather than listing every item.',
      inputSchema: {
        maxCourses: z.number().int().min(1).max(40).optional().describe('Default 15.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_grade_summary', async ({ maxCourses }) => {
      const client = await getClient();
      const userId = await client.selfId();
      const memberships = (await client.listCourses({ availableOnly: true })).slice(
        0,
        maxCourses ?? 15,
      );

      const responses = await client.batch<Paged<BbGrade>>(
        memberships.map((m) => ({
          method: 'GET' as const,
          relativeUrl: `v1/courses/${m.course?.id ?? m.courseId}/gradebook/grades?userId=${userId}&limit=100&expand=column`,
        })),
      );

      const rows = responses.map((res, i) => {
        const m = memberships[i]!;
        const label = courseLabel(m.course);
        const status = res.status ?? res.code ?? 200;
        if (status >= 400 || !res.body) {
          return { course: clip(label, 34), graded: '-', total: '-', average: `HTTP ${status}` };
        }
        const items = res.body.results ?? [];
        let earned = 0;
        let possible = 0;
        let graded = 0;
        for (const g of items) {
          if (g.isExempt || g.isCalculatedColumnGrade) continue;
          const score = g.effectiveScore ?? g.manualScore ?? g.displayGrade?.score;
          const max = g.column?.possible ?? g.pointsPossible;
          if (score === undefined || !max) continue;
          earned += score;
          possible += max;
          graded += 1;
        }
        return {
          course: clip(label, 34),
          graded: `${graded}/${items.length}`,
          total: possible ? `${earned.toFixed(1)}/${possible.toFixed(1)}` : '-',
          average: possible ? `${Math.round((earned / possible) * 100)}%` : '-',
        };
      });

      return text(
        [
          '# Grade standing',
          '',
          table(rows),
          '',
          '_Averages are unweighted point totals over graded items only. A course\'s official weighted grade may differ. Check its final grade column._',
        ].join('\n'),
      );
    }),
  );
  // ── writes ──────────────────────────────────────────────────────────────

  server.registerTool(
    'bb_save_draft',
    {
      title: 'Save a draft submission',
      description:
        'Saves text onto an assignment as a DRAFT, without submitting it. The instructor does not see a draft, and it can be overwritten or submitted later. Use this to stage work, and bb_submit_assignment to actually hand it in. Requires writes to be enabled.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id of the assignment, from bb_list_grades.'),
        text: z.string().min(1).describe('The submission text. Plain text or simple HTML.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('bb_save_draft', async ({ courseId, columnId, text: body }) => {
      const client = await getClient();
      assertWritesEnabled(client.config.allowWrites);

      const column = await client.getGradeColumn(courseId, columnId);
      const draft = await client.createDraftAttempt(courseId, columnId);
      const saved = await client.writeAttempt(courseId, draft.id, {
        text: body,
        submit: false,
        scoreProviderHandle: column.scoreProviderHandle,
      });

      return text(
        [
          `Draft saved for **${columnName(column)}**. Not submitted.`,
          '',
          table([
            { field: 'attemptId', value: saved.id },
            { field: 'status', value: saved.status },
            { field: 'characters', value: body.length },
            { field: 'due', value: column.dueDate ? `${when(column.dueDate)} (${relativeDue(column.dueDate)})` : undefined },
          ]),
          '',
          `_The instructor cannot see a draft. To hand it in, call \`bb_submit_assignment\` with courseId, columnId and confirm: true._`,
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_submit_assignment',
    {
      title: 'Submit an assignment',
      description:
        'SUBMITS text to an assignment for grading. This is visible to the instructor immediately and CANNOT be undone through this API. Requires writes to be enabled AND confirm: true. Never call this speculatively or to "test" anything. Text only: file attachments are not supported. Check the due date and any existing submission first with bb_get_grade_detail.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id of the assignment, from bb_list_grades.'),
        text: z.string().min(1).describe('The work to submit. Plain text or simple HTML.'),
        confirm: z
          .boolean()
          .describe('Must be true. Set this only when the user has explicitly asked to submit this specific assignment.'),
        allowResubmit: z
          .boolean()
          .optional()
          .describe('Permit submitting when an attempt already exists. Default false, which refuses rather than overwrite.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard('bb_submit_assignment', async (args) => {
      const client = await getClient();
      assertWritesEnabled(client.config.allowWrites);

      if (args.confirm !== true) {
        throw new BlackboardError('BAD_INPUT', 'Submission refused: confirm was not true.', {
          hint: 'Submitting is irreversible and visible to the instructor. Ask the user to confirm this specific assignment, then pass confirm: true.',
        });
      }

      const column = await client.getGradeColumn(args.courseId, args.columnId);
      const label = columnName(column);

      // Refuse to walk over existing work unless told to. An accidental
      // resubmission can replace a real submission with worse content.
      const existing = await client.getColumnGrades(args.courseId, args.columnId).catch(() => []);
      const prior = existing[0];
      const alreadySubmitted =
        prior?.status === 'GRADED' ||
        prior?.status === 'NEEDS_GRADING' ||
        (prior?.lastAttemptId != null && prior.lastAttemptId !== '');

      if (alreadySubmitted && !args.allowResubmit) {
        throw new BlackboardError('FORBIDDEN', `"${label}" already has a submission.`, {
          hint: `Status is ${prior?.status ?? 'unknown'}. Inspect it with bb_get_grade_detail. If the user genuinely wants to submit again, pass allowResubmit: true, and note that attempts allowed is ${column.multipleAttempts ?? 'unknown'}.`,
        });
      }

      const draft = await client.createDraftAttempt(args.courseId, args.columnId);
      const result = await client.writeAttempt(args.courseId, draft.id, {
        text: args.text,
        submit: true,
        scoreProviderHandle: column.scoreProviderHandle,
      });

      const receipt = result.attemptReceipt;
      const submitted = receipt?.receiptId !== undefined;

      return text(
        [
          submitted ? `# Submitted: ${label}` : `# Submission may not have completed: ${label}`,
          '',
          table([
            { field: 'status', value: result.status },
            { field: 'receipt', value: receipt?.receiptId ?? '(none returned)' },
            { field: 'submitted at', value: when(receipt?.submissionDate ?? result.attemptDate) },
            { field: 'late', value: receipt?.lateSubmission === true ? 'YES' : 'no' },
            { field: 'size', value: receipt?.submissionTotalSize ? fmtBytes(receipt.submissionTotalSize) : undefined },
            { field: 'attemptId', value: result.id },
            { field: 'due', value: column.dueDate ? `${when(column.dueDate)} (${relativeDue(column.dueDate)})` : undefined },
            { field: 'points possible', value: column.possible },
          ]),
          '',
          receipt?.lateSubmission === true
            ? '**This was recorded as a late submission.**'
            : '',
          submitted
            ? `Keep the receipt id as proof of submission. Verify independently with \`bb_get_grade_detail\` for columnId ${args.columnId}.`
            : 'No receipt came back, so treat this as unconfirmed and check in Blackboard directly.',
        ].join('\n'),
      );
    }),
  );
  server.registerTool(
    'bb_review_quiz_attempt',
    {
      title: 'Review a quiz or test attempt',
      description:
        'Reads back a completed assessment attempt question by question: the question text, the options, which the student chose, the points awarded, and the correct answer plus feedback where the course permits it. Ideal for revising from a past quiz. Get the attemptId from bb_get_grade_detail. Output is windowed, so page with fromQuestion on long tests.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        attemptId: z.string().describe('Attempt id, from bb_get_grade_detail.'),
        fromQuestion: z.number().int().min(1).optional().describe('First question to show. Default 1.'),
        maxQuestions: z.number().int().min(1).max(50).optional().describe('Questions per call. Default 10.'),
        includeText: z
          .boolean()
          .optional()
          .describe('Include full question and option text. Default true. Set false for a score-only summary.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_review_quiz_attempt', async (args) => {
      const client = await getClient();
      const graded = await client.listAttemptAnswerGrades(args.courseId, args.attemptId);

      if (graded.length === 0) {
        return text(
          [
            'No per-question data for this attempt.',
            '',
            'That is expected when the assignment is a file or text submission rather than a quiz, or when the course has not released results. `bb_get_grade_detail` shows the overall grade either way.',
          ].join('\n'),
        );
      }

      // Order by the number the student saw, falling back to stored position.
      const rows = [...graded].sort((a, b) => {
        const an = a.questionAttempt?.visibleQuestionNumber ?? a.questionAttempt?.question?.position ?? 0;
        const bn = b.questionAttempt?.visibleQuestionNumber ?? b.questionAttempt?.question?.position ?? 0;
        return an - bn;
      });

      const from = args.fromQuestion ?? 1;
      const take = args.maxQuestions ?? 10;
      const window = rows.slice(from - 1, from - 1 + take);
      const showText = args.includeText !== false;

      let earned = 0;
      let possible = 0;
      for (const r of rows) {
        earned += r.points ?? 0;
        possible += r.questionAttempt?.question?.points ?? 0;
      }

      // The tenant decides what a student may see after submitting. Honour it
      // rather than implying the data is missing.
      const first = rows[0]?.questionAttempt;
      const scoresHidden = first?.isScoreVisible === false;
      const answersHidden = first?.isCorrectAnswersVisible === false;

      let truncated = false;
      const keep = (v: string | undefined, max: number): string => {
        const t = htmlToText(v ?? '');
        if (t.length > max) truncated = true;
        return clip(t, max);
      };

      const blocks = window.map((r, i) => {
        const qa = r.questionAttempt;
        const q = qa?.question;
        const n = qa?.visibleQuestionNumber ?? from + i;
        const given = qa?.givenAnswer;

        // A multipleanswer question returns booleans aligned with the options.
        let chosen = '';
        if (Array.isArray(given) && q?.answers?.length) {
          const picked = q.answers
            .filter((_, idx) => given[idx] === true)
            .map((a) => keep(a.answerText?.displayText ?? a.answerText?.rawText, 400));
          chosen = picked.length ? picked.join('; ') : '(nothing selected)';
        } else if (typeof given === 'string') {
          chosen = clip(htmlToText(given), 2000);
        } else if (given != null) {
          chosen = clip(JSON.stringify(given), 120);
        } else {
          chosen = '(no answer recorded)';
        }

        const head = table([
          { field: 'type', value: q?.questionType },
          { field: 'score', value: scoresHidden ? 'hidden by the course' : `${r.points ?? 0} / ${q?.points ?? '?'}` },
          { field: 'status', value: qa?.attemptStatus },
          { field: 'auto-graded', value: q?.isAutoGraded === false ? 'no' : undefined },
        ]);

        const parts = [`### Question ${n}`, '', head];

        if (showText && q?.questionText) {
          parts.push('', keep(q.questionText.displayText ?? q.questionText.rawText, 4000));
        }
        if (showText && q?.answers?.length) {
          parts.push(
            '',
            table(
              q.answers.map((a, idx) => ({
                option: idx + 1,
                text: keep(a.answerText?.displayText ?? a.answerText?.rawText, 400),
                chose: Array.isArray(given) && given[idx] === true ? 'yes' : '',
              })),
            ),
          );
        }
        parts.push('', `**Your answer:** ${chosen}`);

        const fb = qa?.isFeedbackVisible === false
          ? undefined
          : (r.points ?? 0) >= (q?.points ?? 0)
            ? q?.correctResponseFeedback
            : q?.incorrectResponseFeedback;
        const fbText = fb ? htmlToText(fb.displayText ?? fb.rawText ?? '') : '';
        if (fbText) parts.push('', `**Feedback:** ${clip(fbText, 2000)}`);

        return parts.join('\n');
      });

      const last = Math.min(from + window.length - 1, rows.length);
      const notes: string[] = [];
      if (scoresHidden) notes.push('This course has not released per-question scores.');
      if (answersHidden) notes.push('This course does not reveal which answers were correct, so only your own responses are shown.');
      if (last < rows.length) notes.push(`Showing questions ${from}-${last} of ${rows.length}. Call again with fromQuestion=${last + 1}.`);
      if (truncated) notes.push('Some text was long enough to be shortened; reduce maxQuestions to see more of each question.');

      return text(
        [
          `# Quiz attempt ${args.attemptId}`,
          '',
          table([
            { field: 'questions', value: rows.length },
            { field: 'total', value: scoresHidden ? 'hidden' : `${earned} / ${possible}` },
            { field: 'percent', value: scoresHidden || !possible ? undefined : `${Math.round((earned / possible) * 100)}%` },
          ]),
          notes.length ? `\n> ${notes.join(' ')}\n` : '',
          blocks.join('\n\n---\n\n'),
        ].join('\n'),
      );
    }),
  );
  server.registerTool(
    'bb_submission_status',
    {
      title: 'Has this been submitted?',
      description:
        'Definitive answer to whether an assignment has been submitted, with the attempt id, timestamp and late flag. Use this rather than inferring from a grade list or attempt list, both of which can read as "not submitted" for work that was submitted.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id from bb_list_grades.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_submission_status', async ({ courseId, columnId }) => {
      const client = await getClient();
      const [column, status] = await Promise.all([
        client.getGradeColumn(courseId, columnId).catch(() => undefined),
        client.getSubmissionStatus(courseId, columnId),
      ]);

      return text(
        [
          `# ${column ? columnName(column) : columnId}`,
          '',
          status.submitted ? '**Submitted.**' : '**Not submitted.**',
          '',
          table([
            { field: 'attemptId', value: status.attemptId },
            { field: 'status', value: status.status },
            { field: 'submitted at', value: when(status.submittedAt) },
            { field: 'late', value: status.late === true ? 'YES' : status.late === false ? 'no' : undefined },
            { field: 'attempts', value: status.attemptCount },
            { field: 'due', value: column?.dueDate ? `${when(column.dueDate)} (${relativeDue(column.dueDate)})` : undefined },
            { field: 'points possible', value: column?.possible },
          ]),
          '',
          status.submitted
            ? '_All timestamps are UTC. Convert for display._'
            : '_Derived from the gradebook record. A missing grade record means no attempt exists._',
        ].join('\n'),
      );
    }),
  );
  server.registerTool(
    'bb_submit_quiz_attempt',
    {
      title: 'Submit a quiz or test attempt',
      description:
        'SUBMITS an in-progress assessment attempt for grading. Irreversible, immediately visible to the instructor, and an auto-graded test is scored on the spot, so a wrong call cannot be walked back. Requires writes to be enabled AND confirm: true. Answers must already be saved on the attempt; this only changes its status. Always show the user the attempt and its answers (bb_review_quiz_attempt) and get their explicit go-ahead before calling this.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        attemptId: z
          .string()
          .describe('The IN_PROGRESS attempt to submit. Verify it with bb_review_quiz_attempt first.'),
        confirm: z
          .boolean()
          .describe('Must be true. Set this only when the user has explicitly approved submitting this specific attempt.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard('bb_submit_quiz_attempt', async (args) => {
      const client = await getClient();
      assertWritesEnabled(client.config.allowWrites);

      if (args.confirm !== true) {
        throw new BlackboardError('BAD_INPUT', 'Submission refused: confirm was not true.', {
          hint: 'Submitting a quiz is irreversible and an auto-graded test scores immediately. Show the user the attempt, get an explicit yes, then pass confirm: true.',
        });
      }

      // Read the attempt first. Submitting something already submitted, or an
      // attempt that does not exist, should fail before any write is attempted.
      const before = await client.getAttempt(args.courseId, args.attemptId);
      if (before.status && before.status !== 'IN_PROGRESS') {
        throw new BlackboardError('FORBIDDEN', `This attempt is already ${before.status}.`, {
          hint: 'Only an IN_PROGRESS attempt can be submitted. Use bb_review_quiz_attempt to inspect what was recorded.',
        });
      }

      const answered = await client
        .listAttemptAnswers(args.courseId, args.attemptId)
        .catch(() => []);
      const blank = answered.filter(
        (a) => a.givenAnswer === undefined || a.givenAnswer === null,
      ).length;

      const result = await client.submitAssessmentAttempt(args.courseId, args.attemptId);
      const receipt = result.attemptReceipt;
      const submitted = receipt?.receiptId !== undefined;

      return text(
        [
          submitted ? '# Quiz submitted' : '# Submission may not have completed',
          '',
          table([
            { field: 'attemptId', value: result.id },
            { field: 'status', value: result.status },
            { field: 'receipt', value: receipt?.receiptId ?? '(none returned)' },
            { field: 'submitted at', value: when(receipt?.submissionDate ?? result.attemptDate) },
            { field: 'late', value: receipt?.lateSubmission === true ? 'YES' : 'no' },
            { field: 'score', value: result.displayGrade?.score },
            { field: 'questions', value: answered.length || undefined },
            { field: 'left blank', value: blank || undefined },
          ]),
          '',
          receipt?.lateSubmission === true ? '**Recorded as a late submission.**' : '',
          submitted
            ? 'Keep the receipt id as proof. Timestamps are UTC.'
            : 'No receipt came back, so treat this as unconfirmed and check in Blackboard directly.',
        ].join('\n'),
      );
    }),
  );
  server.registerTool(
    'bb_start_quiz_attempt',
    {
      title: 'Start a quiz attempt',
      description:
        'Opens an IN_PROGRESS attempt on an assessment and lists its questions with their options and numbering. Returns the same attempt if one is already open, so it is safe to call more than once. Starting an attempt may consume one of a limited number and can start a timer; check bb_get_content for the assessment settings first. Requires writes to be enabled.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id of the assessment.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('bb_start_quiz_attempt', async ({ courseId, columnId }) => {
      const client = await getClient();
      assertWritesEnabled(client.config.allowWrites);

      const column = await client.getGradeColumn(courseId, columnId);
      const attempt = await client.createDraftAttempt(courseId, columnId);
      const answers = await client.listAttemptAnswers(courseId, attempt.id).catch(() => []);

      const rows = answers
        .sort(
          (a, b) =>
            (a.visibleQuestionNumber ?? a.question?.position ?? 0) -
            (b.visibleQuestionNumber ?? b.question?.position ?? 0),
        )
        .map((a, i) => ({
          question: a.visibleQuestionNumber ?? i + 1,
          answerId: a.id,
          type: a.questionType ?? a.question?.questionType,
          points: a.question?.points,
          options: a.question?.answers?.length || undefined,
          answered: a.givenAnswer === undefined || a.givenAnswer === null ? '' : 'yes',
        }));

      return text(
        [
          `# ${columnName(column)}`,
          '',
          table([
            { field: 'attemptId', value: attempt.id },
            { field: 'status', value: attempt.status },
            { field: 'questions', value: rows.length || undefined },
            { field: 'points possible', value: column.possible },
            { field: 'attempts allowed', value: column.multipleAttempts || 'unlimited' },
          ]),
          '',
          rows.length ? table(rows) : '_No question records returned; this may not be an assessment._',
          '',
          '_Answer with `bb_save_quiz_answer`, then submit with `bb_submit_quiz_attempt`._',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_save_quiz_answer',
    {
      title: 'Save an answer to a quiz question',
      description:
        'Writes an answer onto one question of an IN_PROGRESS attempt. Saving is not submitting: answers can be overwritten until the attempt is submitted. Accepts natural input and resolves it against the question, so option numbers (1-based), option text, booleans for true/false, plain text for essays, or numbers for numeric questions all work. Echoes back how the input was interpreted so it can be verified before submitting. Requires writes to be enabled.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        attemptId: z.string().describe('The IN_PROGRESS attempt, from bb_start_quiz_attempt.'),
        question: z
          .union([z.number().int().min(1), z.string()])
          .describe('Question number as shown to the student, or the answerId directly.'),
        answer: z
          .union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.union([z.string(), z.number(), z.boolean()])),
          ])
          .describe(
            'The answer. Choice questions take option numbers or text (an array selects several); true/false takes a boolean; essays take text; numeric takes a number.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('bb_save_quiz_answer', async (args) => {
      const client = await getClient();
      assertWritesEnabled(client.config.allowWrites);

      const answers = await client.listAttemptAnswers(args.courseId, args.attemptId);
      if (answers.length === 0) {
        throw new BlackboardError('NOT_FOUND', 'This attempt has no question records.', {
          hint: 'Start the attempt with bb_start_quiz_attempt, and check that it is still IN_PROGRESS.',
        });
      }

      const sorted = [...answers].sort(
        (a, b) =>
          (a.visibleQuestionNumber ?? a.question?.position ?? 0) -
          (b.visibleQuestionNumber ?? b.question?.position ?? 0),
      );

      const target =
        typeof args.question === 'string'
          ? sorted.find((a) => a.id === args.question)
          : (sorted.find((a) => a.visibleQuestionNumber === args.question) ??
            sorted[args.question - 1]);

      if (!target?.id) {
        throw new BlackboardError('NOT_FOUND', `No question ${args.question} on this attempt.`, {
          hint: `This attempt has ${sorted.length} question(s), numbered 1 to ${sorted.length}.`,
        });
      }

      const encoded = encodeAnswer(target, args.answer as LooseAnswer);
      const saved = await client.saveQuizAnswer(args.courseId, args.attemptId, target.id, {
        questionType: target.questionType ?? target.question?.questionType ?? 'multipleanswer',
        givenAnswer: encoded.givenAnswer,
      });

      const q = target.question;
      const remaining = sorted.filter(
        (a) => a.id !== target.id && (a.givenAnswer === undefined || a.givenAnswer === null),
      ).length;

      return text(
        [
          `Saved answer to question ${target.visibleQuestionNumber ?? args.question}.`,
          '',
          table([
            { field: 'answerId', value: target.id },
            { field: 'type', value: target.questionType ?? q?.questionType },
            { field: 'interpreted as', value: encoded.interpretation },
            { field: 'attempt status', value: saved.attemptStatus ?? target.attemptStatus },
            { field: 'points', value: q?.points },
            { field: 'still unanswered', value: remaining || undefined },
          ]),
          encoded.passthrough
            ? '\n> The question type was not recognised, so the value was sent unchanged. Verify it with `bb_review_quiz_attempt`.'
            : '',
          q?.answers?.length ? `\n**Options**\n\n${describeOptions(q)}` : '',
          '',
          '_Not submitted. Answers can be overwritten until you call `bb_submit_quiz_attempt`._',
        ].join('\n'),
      );
    }),
  );
}
