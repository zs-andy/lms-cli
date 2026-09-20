import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section } from './helpers.js';
import { displayName, courseLabel } from '../client/index.js';
import { Session } from '../auth/session.js';
import { loadConfigOrNull } from '../config.js';

export function registerCourseTools(server: McpServer): void {
  // ── identity & session ──────────────────────────────────────────────────

  server.registerTool(
    'bb_whoami',
    {
      title: 'Who am I on Blackboard',
      description:
        'Returns the signed-in Blackboard user (name, username, student id, email, institution roles) and the configured instance. Use this to confirm authentication is working before other calls.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_whoami', async () => {
      const client = await getClient();
      const me = await client.whoami();
      return text(
        [
          `**${displayName(me)}** on ${client.config.label ?? client.config.baseUrl}`,
          '',
          table([
            { field: 'user id', value: me.id },
            { field: 'username', value: me.userName },
            { field: 'student id', value: me.studentId },
            { field: 'email', value: me.emailAddress },
            { field: 'department', value: me.department },
            { field: 'system role', value: me.systemRole },
            { field: 'institution roles', value: (me.insRoles ?? []).join(', ') },
            { field: 'locale', value: me.locale },
          ]),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_session_status',
    {
      title: 'Blackboard session status',
      description:
        'Reports how much longer the stored Blackboard session is valid, when it was captured, and which cookies it holds. Call this when other tools start failing with session errors.',
      inputSchema: {
        keepAlive: z
          .boolean()
          .optional()
          .describe('Also ping the keep-alive endpoint to extend the session.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_session_status', async ({ keepAlive }) => {
      const config = loadConfigOrNull();
      const session = await Session.tryLoad();
      if (!config || !session) {
        return text(
          'No Blackboard session stored.\n\nRun `blackboard-mcp auth login` in a terminal to sign in.',
        );
      }
      const rows: Array<Record<string, string | number | undefined>> = [
        { field: 'instance', value: session.baseUrl },
        { field: 'captured', value: `${when(session.capturedAt.toISOString())} (${session.ageHours.toFixed(1)}h ago)` },
        { field: 'cookies', value: (await session.cookieNames()).join(', ') },
        { field: 'xsrf token', value: session.xsrfToken ? 'present' : 'absent' },
        { field: 'writes', value: config.allowWrites ? 'enabled' : 'disabled (read-only)' },
      ];

      let live = '';
      try {
        const client = await getClient();
        if (keepAlive) await client.keepAlive();
        const secs = await client.sessionSecondsRemaining();
        rows.push({
          field: 'expires in',
          value: secs > 0 ? `${Math.round(secs / 60)} min` : 'expired',
        });
        live = secs > 0 ? 'Session is **live**.' : 'Session has **expired**. Run `blackboard-mcp auth login`.';
      } catch (err) {
        live = `Could not reach Blackboard to verify: ${(err as Error).message}`;
      }

      return text(`${live}\n\n${table(rows)}`);
    }),
  );

  // ── courses ─────────────────────────────────────────────────────────────

  server.registerTool(
    'bb_list_courses',
    {
      title: 'List my Blackboard courses',
      description:
        'Lists the courses the signed-in user is enrolled in, with course id, name, term, role and last-access date. The returned `courseId` (like `_12345_1`) is what every other course tool needs. Start here.',
      inputSchema: {
        availableOnly: z
          .boolean()
          .optional()
          .describe('Only courses currently open to the student. Default false (show all).'),
        includeHidden: z
          .boolean()
          .optional()
          .describe('Include courses the user hid from their own course list. Default false.'),
        organizations: z
          .enum(['exclude', 'only', 'include'])
          .optional()
          .describe('Organizations/communities are excluded by default; "only" or "include" to change that.'),
        term: z.string().optional().describe('Case-insensitive substring filter on the term name.'),
        search: z.string().optional().describe('Case-insensitive substring filter on course name or code.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_courses', async (args) => {
      const client = await getClient();
      let rows = await client.listCourses({
        availableOnly: args.availableOnly,
        includeHidden: args.includeHidden,
        organizations: args.organizations,
      });

      if (args.term) {
        const needle = args.term.toLowerCase();
        rows = rows.filter((m) => (m.course?.term?.name ?? '').toLowerCase().includes(needle));
      }
      if (args.search) {
        const needle = args.search.toLowerCase();
        rows = rows.filter((m) =>
          `${courseLabel(m.course)} ${m.course?.courseId ?? ''}`.toLowerCase().includes(needle),
        );
      }

      // Most recently accessed first: that is nearly always what is wanted.
      rows.sort((a, b) => (b.lastAccessDate ?? '').localeCompare(a.lastAccessDate ?? ''));

      const body = table(
        rows.map((m) => ({
          courseId: m.course?.id ?? m.courseId,
          name: clip(courseLabel(m.course), 60),
          code: m.course?.displayId ?? m.course?.courseId,
          term: m.course?.term?.name,
          role: m.courseRole?.courseName ?? m.role,
          available: m.course?.isAvailable === false ? 'no' : 'yes',
          lastAccess: when(m.lastAccessDate),
        })),
      );

      return text(`${rows.length} course(s).\n\n${body}`);
    }),
  );

  server.registerTool(
    'bb_get_course',
    {
      title: 'Get Blackboard course details',
      description:
        'Full detail for one course: name, code, term, availability window, Ultra/Classic mode, and the tools enabled in it.',
      inputSchema: {
        courseId: z.string().describe('Course id from bb_list_courses, e.g. "_12345_1".'),
        includeTools: z.boolean().optional().describe('Also list the course tools. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_get_course', async ({ courseId, includeTools }) => {
      const client = await getClient();
      const course = await client.getCourse(courseId);

      const head = table([
        { field: 'name', value: courseLabel(course) },
        { field: 'course id', value: course.id },
        { field: 'code', value: course.courseId },
        { field: 'term', value: course.term?.name ?? course.termId },
        { field: 'available', value: course.isAvailable === false ? 'no' : 'yes' },
        { field: 'closed', value: course.isClosed ? 'yes' : 'no' },
        { field: 'organization', value: course.isOrganization ? 'yes' : 'no' },
        { field: 'mode', value: course.ultraStatus },
        { field: 'created', value: when(course.createdDate) },
        { field: 'modified', value: when(course.modifiedDate) },
      ]);

      let tools = '';
      if (includeTools !== false) {
        try {
          const list = (await client.listCourseTools(courseId)) as Array<Record<string, unknown>>;
          tools = table(
            list.slice(0, 60).map((t) => ({
              tool: String(t.title ?? t.name ?? t.id ?? ''),
              available: t.isAvailable === false ? 'no' : 'yes',
            })),
          );
        } catch {
          tools = '_Course tools unavailable for this course._';
        }
      }

      const desc = course.description ? clip(course.description, 800) : '';

      return text(
        `# ${courseLabel(course)}\n\n${head}${section('Description', desc)}${section('Tools', tools)}`,
      );
    }),
  );

  server.registerTool(
    'bb_list_terms',
    {
      title: 'List Blackboard terms',
      description: 'Lists academic terms defined on the instance, with their date ranges.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_terms', async ({ limit }) => {
      const client = await getClient();
      const terms = await client.listTerms({ limit: limit ?? 100 });
      return text(
        table(
          terms.map((t) => ({
            id: t.id,
            name: t.name,
            available: t.isAvailable === false ? 'no' : 'yes',
            start: when(t.startDate ?? undefined),
            end: when(t.endDate ?? undefined),
          })),
        ),
      );
    }),
  );

  server.registerTool(
    'bb_list_roster',
    {
      title: 'List course participants',
      description:
        'Lists the people enrolled in a course with their roles. Useful for finding an instructor to contact, or identifying group members.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        role: z
          .enum(['all', 'instructors', 'students'])
          .optional()
          .describe('Filter by role bucket. Default "all".'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_roster', async ({ courseId, role, limit }) => {
      const client = await getClient();
      let rows = await client.listRoster(courseId, { limit: limit ?? 200 });

      if (role === 'instructors') {
        rows = rows.filter((m) => m.courseRole?.isActAsInstructor === true || m.role === 'P');
      } else if (role === 'students') {
        rows = rows.filter((m) => m.role === 'S');
      }

      return text(
        `${rows.length} participant(s).\n\n${table(
          rows.map((m) => ({
            name: m.user ? displayName(m.user) : m.userId,
            role: m.courseRole?.courseName ?? m.role,
            email: m.user?.emailAddress,
            userId: m.userId,
          })),
        )}`,
      );
    }),
  );
}
