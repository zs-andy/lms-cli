import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section, relativeDue } from './helpers.js';
import { courseLabel, type BbAnnouncement, type Paged } from '../client/index.js';
import { htmlToText } from '../lib/extract.js';

export function registerCommsTools(server: McpServer): void {
  server.registerTool(
    'bb_announcements',
    {
      title: 'Read Blackboard announcements',
      description:
        'Lists course announcements with their full text, newest first. Covers every enrolled course by default (via the batch API), or one course when courseId is given. Use this for "what did my instructors post?" or catching up after time away.',
      inputSchema: {
        courseId: z.string().optional().describe('One course. Omit for all enrolled courses.'),
        limit: z.number().int().min(1).max(100).optional().describe('Per course. Default 10.'),
        unreadOnly: z.boolean().optional().describe('Only announcements not yet marked read.'),
        fullText: z
          .boolean()
          .optional()
          .describe('Include the complete body rather than a preview. Default true for a single course.'),
        maxCourses: z.number().int().min(1).max(40).optional().describe('Default 15.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_announcements', async (args) => {
      const client = await getClient();
      const perCourse = args.limit ?? 10;

      const render = (rows: BbAnnouncement[], full: boolean): string =>
        rows
          .map((a) => {
            const body = a.body?.displayText
              ? htmlToText(a.body.displayText)
              : (a.body?.rawText ?? '');
            const meta = [
              a._courseName ? `**${a._courseName}**` : '',
              a.createdDate ?? a.startDateRestriction ?? '',
              `id: ${a.id}`,
              `source: ${client.config.baseUrl}/ultra/courses/${(a as BbAnnouncement & { _sourceCourseId?: string })._sourceCourseId ?? args.courseId}/announcements`,
              a.readStatus?.isRead === false ? '*unread*' : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return `### ${a.title ?? '(untitled)'}\n${meta}\n\n${full ? body : clip(body, 400)}`;
          })
          .join('\n\n---\n\n');

      // ── single course ──
      if (args.courseId) {
        let rows = await client.listCourseAnnouncements(args.courseId, { limit: perCourse });
        if (args.unreadOnly) rows = rows.filter((a) => a.readStatus?.isRead === false);
        const label = await client.courseName(args.courseId);
        return text(
          [
            `# Announcements: ${label}`,
            '',
            `${rows.length} announcement(s).`,
            '',
            rows.length ? render(rows, args.fullText !== false) : '_None._',
          ].join('\n'),
        );
      }

      // ── every course, batched ──
      const allMemberships = await client.listCourses({ availableOnly: true });
      const memberships = allMemberships.slice(
        0,
        args.maxCourses ?? 15,
      );
      const responses = await client.batch<Paged<BbAnnouncement>>(
        memberships.map((m) => ({
          method: 'GET' as const,
          relativeUrl: `v1/courses/${m.course?.id ?? m.courseId}/announcements?limit=${perCourse}&offset=0&sort=startDateRestriction(desc)`,
        })),
      );

      const all: BbAnnouncement[] = [];
      const failures: string[] = [];
      memberships.forEach((m, i) => {
        const res = responses[i];
        const label = courseLabel(m.course);
        const status = res?.status ?? res?.code ?? 200;
        if (status >= 400 || !res?.body) {
          failures.push(`${label} (HTTP ${status})`);
          return;
        }
        for (const a of res.body.results ?? []) {
          if (args.unreadOnly && a.readStatus?.isRead !== false) continue;
          all.push({ ...a, _courseName: label, _sourceCourseId: m.course?.id ?? m.courseId } as BbAnnouncement);
        }
      });

      all.sort((a, b) =>
        (b.createdDate ?? b.startDateRestriction ?? '').localeCompare(
          a.createdDate ?? a.startDateRestriction ?? '',
        ),
      );

      return text(
        [
          `# Announcements across ${memberships.length - failures.length} course(s)`,
          '',
          `${all.length} announcement(s)${args.unreadOnly ? ' (unread only)' : ''}.`,
          `Coverage: first ${perCourse} announcements per course; ${memberships.length}/${allMemberships.length} available courses. Older announcements and later pages are not included.`,
          '',
          all.length ? render(all, args.fullText === true) : '_None._',
          failures.length ? `\n_Could not read: ${failures.join('; ')}_` : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_activity_stream',
    {
      title: 'Blackboard activity stream',
      description:
        'The Ultra activity stream: recent grade postings, new content, announcements and due-date reminders across all courses, newest first. A good single call for "what changed recently?".',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Default 40.'),
        flushCache: z
          .boolean()
          .optional()
          .describe('Force Blackboard to rebuild the stream rather than serve a cached copy.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_activity_stream', async ({ limit, flushCache }) => {
      const client = await getClient();
      const stream = await client.getStream({ flushCache });
      const entries = stream.sv_streamEntries ?? [];

      // The stream references courses by id and ships the names in a side-car.
      const names = new Map<string, string>();
      for (const c of stream.sv_extras?.sx_courses ?? []) {
        if (c.id) names.set(c.id, courseLabel(c));
      }

      const rows = entries
        .sort((a, b) => (b.se_timestamp ?? 0) - (a.se_timestamp ?? 0))
        .slice(0, limit ?? 40)
        .map((e) => ({
          when: when(e.se_timestamp),
          what: clip(String(e.se_itemTitle ?? e.se_context ?? ''), 55),
          course: clip(names.get(String(e.se_courseId ?? '')) ?? String(e.se_courseId ?? ''), 30),
          kind: String(e.se_provider ?? '').replace(/^bb-/, ''),
          unread: e.se_read === false ? 'new' : undefined,
        }));

      if (rows.length === 0) {
        return text(
          'The activity stream is empty.\n\nBlackboard builds this asynchronously. If you expected entries, retry with flushCache=true.',
        );
      }

      return text(`# Activity stream\n\n${rows.length} entr(ies).\n\n${table(rows)}`);
    }),
  );

  server.registerTool(
    'bb_list_conversations',
    {
      title: 'List course messages',
      description:
        'Lists the message threads (Blackboard "conversations") in a course, and optionally the messages inside one thread.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        conversationId: z
          .string()
          .optional()
          .describe('Read the messages in this thread instead of listing threads.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_conversations', async ({ courseId, conversationId, limit }) => {
      const client = await getClient();
      const label = await client.courseName(courseId);

      if (conversationId) {
        const msgs = await client.listConversationMessages(courseId, conversationId, {
          limit: limit ?? 50,
        });
        const body = msgs
          .map((m) => {
            const t = m.body?.displayText ? htmlToText(m.body.displayText) : (m.body?.rawText ?? '');
            return `### ${when(m.createdDate)}${m.isRead === false ? ' · *unread*' : ''}\n\n${clip(t, 1500)}`;
          })
          .join('\n\n---\n\n');
        return text(`# Thread ${conversationId}: ${label}\n\n${body || '_No messages._'}`);
      }

      const rows = await client.listConversations(courseId, { limit: limit ?? 50 });
      return text(
        [
          `# Messages: ${label}`,
          '',
          `${rows.length} thread(s).`,
          '',
          table(
            rows.map((c) => ({
              conversationId: c.id,
              subject: clip(c.subject ?? c.title, 50),
              messages: c.messageCount,
              unread: c.unreadCount || undefined,
              modified: when(c.modifiedDate ?? c.createdDate),
            })),
          ),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_list_discussions',
    {
      title: 'Read course discussions',
      description:
        'Reads a discussion forum: its top-level posts, and the replies to one post when messageId is given. Find the forumId from a "discussion" item in bb_browse_course (its contentDetail carries conferenceId/id).',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        forumId: z.string().describe('Forum id, e.g. "_20001_1".'),
        messageId: z.string().optional().describe('Read replies to this post.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_discussions', async ({ courseId, forumId, messageId, limit }) => {
      const client = await getClient();
      const rows = messageId
        ? await client.listForumReplies(courseId, forumId, messageId, { limit: limit ?? 50 })
        : await client.listForumMessages(courseId, forumId, { limit: limit ?? 50 });

      const body = rows
        .map((m) => {
          const t = m.body?.displayText ? htmlToText(m.body.displayText) : (m.body?.rawText ?? '');
          const meta = [when(m.createdDate), m.replyCount ? `${m.replyCount} repl(ies)` : '', m.isRead === false ? '*unread*' : '']
            .filter(Boolean)
            .join(' · ');
          return `### ${m.subject ?? '(no subject)'}\nid: \`${m.id}\` · ${meta}\n\n${clip(t, 1200)}`;
        })
        .join('\n\n---\n\n');

      return text(
        [
          messageId ? `# Replies to ${messageId}` : `# Forum ${forumId}`,
          '',
          `${rows.length} post(s).`,
          '',
          body || '_No posts._',
          messageId ? '' : '\n_Pass a post id as `messageId` to read its replies._',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_attendance',
    {
      title: 'Get course attendance records',
      description:
        'Lists the attendance records recorded for the signed-in user in a course (present/absent/late/excused per session), when the instructor uses Blackboard attendance.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        limit: z.number().int().min(1).max(400).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_attendance', async ({ courseId, limit }) => {
      const client = await getClient();
      const [label, records] = await Promise.all([
        client.courseName(courseId),
        client.listAttendance(courseId, { limit: limit ?? 200 }),
      ]);

      if (records.length === 0) {
        return text(
          `# Attendance: ${label}\n\n_No attendance records._\n\nThis usually means the instructor does not use Blackboard's attendance tool for this course.`,
        );
      }

      const tally = new Map<string, number>();
      for (const r of records) {
        const k = r.status ?? 'unknown';
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }

      return text(
        [
          `# Attendance: ${label}`,
          '',
          table([...tally.entries()].map(([status, count]) => ({ status, sessions: count }))),
          '',
          table(
            records
              .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
              .map((r) => ({ date: when(r.date), status: r.status })),
          ),
        ].join('\n'),
      );
    }),
  );
  server.registerTool(
    'bb_unread_counts',
    {
      title: 'Unread message and notification counts',
      description:
        'Unread message counts across every course in a single call, plus the overall messages summary. Cheap. Use it to decide whether reading messages is worth it before calling bb_list_conversations.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_unread_counts', async () => {
      const client = await getClient();
      const [counts, summary] = await Promise.all([
        client.conversationCounts().catch((err) => ({ error: (err as Error).message })),
        client.messagesSummary().catch((err) => ({ error: (err as Error).message })),
      ]);

      return text(
        [
          '# Unread counts',
          '',
          '## Per-course conversations',
          '```json',
          JSON.stringify(counts, null, 1).slice(0, 4000),
          '```',
          '',
          '## Messages summary',
          '```json',
          JSON.stringify(summary, null, 1).slice(0, 2000),
          '```',
          '',
          '_Course ids here map to `bb_list_courses` output; pass one to `bb_list_conversations` to read the threads._',
        ].join('\n'),
      );
    }),
  );
}
