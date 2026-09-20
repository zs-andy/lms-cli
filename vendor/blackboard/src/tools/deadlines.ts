import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getClient, guard, text, table, when, clip, section, relativeDue, dateWindow,
} from './helpers.js';
import { courseLabel } from '../client/index.js';

export function registerDeadlineTools(server: McpServer): void {
  server.registerTool(
    'bb_todo',
    {
      title: 'What is due on Blackboard',
      description:
        'The student to-do list: everything overdue, due today, and coming up, across all courses, in one call. This is the right tool for "what do I have due?", "am I behind?", or "what should I work on?". Grouped by urgency and sorted by date.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(180)
          .optional()
          .describe('How far ahead to look. Default 14.'),
        lookBackDays: z
          .number()
          .int()
          .min(0)
          .max(365)
          .optional()
          .describe('How far back to scan for overdue items. Default 30.'),
        includeOverdue: z.boolean().optional().describe('Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_todo', async (args) => {
      const client = await getClient();
      const now = new Date();
      const since = new Date(now.getTime() - (args.lookBackDays ?? 30) * 86_400_000).toISOString();
      const until = new Date(now.getTime() + (args.days ?? 14) * 86_400_000).toISOString();

      const items = await client.listTodo({ since, until });

      // Resolve course names once, from the membership list already cached.
      await client.listCourses({ availableOnly: false }).catch(() => []);
      const named = await Promise.all(
        items.map(async (i) => ({
          ...i,
          _courseName: i._courseId ? await client.courseName(i._courseId) : undefined,
        })),
      );

      const bucket = (name: 'overdue' | 'dueToday' | 'upcoming') =>
        named
          .filter((i) => i._bucket === name)
          .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
          .map((i) => ({
            item: clip(i.title ?? i.column?.effectiveColumnName, 50),
            course: clip(i._courseName, 30),
            due: `${when(i.dueDate)} (${relativeDue(i.dueDate)})`,
            points: i.column?.possible,
            courseId: i._courseId,
            columnId: i.column?.id,
          }));

      const overdue = args.includeOverdue === false ? [] : bucket('overdue');
      const today = bucket('dueToday');
      const upcoming = bucket('upcoming');

      if (overdue.length + today.length + upcoming.length === 0) {
        return text(
          `Nothing due between ${when(since)} and ${when(until)}.\n\nNote this reflects items with due dates set in the gradebook. Work assigned without a due date will not appear. Use \`bb_browse_course\` to check a specific course.`,
        );
      }

      return text(
        [
          '# Blackboard to-do',
          '',
          `Window: ${when(since)} to ${when(until)}`,
          overdue.length ? `\n## Overdue (${overdue.length})\n\n${table(overdue)}` : '',
          today.length ? `\n## Due today (${today.length})\n\n${table(today)}` : '',
          upcoming.length ? `\n## Upcoming (${upcoming.length})\n\n${table(upcoming)}` : '',
          '',
          '_Use `bb_get_grade_detail` with a columnId for the full brief and instructions._',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_calendar',
    {
      title: 'Blackboard calendar events',
      description:
        'Lists calendar entries in a date range: class sessions, instructor-created events, and assignment due dates. Covers all courses by default. Use bb_todo instead when the question is specifically about assignment deadlines.',
      inputSchema: {
        days: z.number().int().min(1).max(180).optional().describe('Days ahead. Default 14.'),
        since: z.string().optional().describe('ISO start, e.g. "2026-09-01T00:00:00Z". Overrides days.'),
        until: z.string().optional().describe('ISO end. Overrides days.'),
        courseId: z.string().optional().describe('Restrict to one course.'),
        limit: z.number().int().min(1).max(400).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_calendar', async (args) => {
      const client = await getClient();
      const { since, until } = dateWindow(args);
      const items = await client.listCalendarItems({
        since,
        until,
        courseId: args.courseId,
        limit: args.limit ?? 200,
      });

      items.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));

      const rows = items.map((i) => ({
        start: when(i.startDate),
        rel: relativeDue(i.startDate),
        title: clip(i.title, 50),
        calendar: clip(i.calendarNameLocalizable?.rawValue ?? i.calendarId, 28),
        location: clip(i.location, 20),
        end: when(i.endDate),
      }));

      return text(
        [
          `# Calendar: ${when(since)} to ${when(until)}`,
          '',
          `${items.length} event(s).`,
          '',
          table(rows),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_course_schedule',
    {
      title: 'Get a course meeting schedule',
      description:
        'Lists the recurring class meetings configured for a course (day, time, room). Empty for courses whose instructor never set one up.',
      inputSchema: { courseId: z.string().describe('Course id, e.g. "_12345_1".') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_course_schedule', async ({ courseId }) => {
      const client = await getClient();
      const [label, items] = await Promise.all([
        client.courseName(courseId),
        client.listCalendarItems({
          since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          until: new Date(Date.now() + 120 * 86_400_000).toISOString(),
          courseId,
          limit: 200,
        }),
      ]);

      const rows = items
        .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))
        .map((i) => ({
          start: when(i.startDate),
          end: when(i.endDate),
          title: clip(i.title, 45),
          location: clip(i.location, 25),
        }));

      return text(
        [
          `# Schedule: ${label}`,
          '',
          rows.length
            ? table(rows)
            : '_No scheduled meetings found for this course in the next 120 days._',
        ].join('\n'),
      );
    }),
  );
}
