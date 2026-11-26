import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MoodleClient, MoodleError } from './client.js';

export const SERVER_NAME = 'moodle-readonly-mcp';
export const SERVER_VERSION = '0.1.0';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function guard<A>(fn: (client: MoodleClient, args: A) => Promise<unknown>, clientFactory: () => MoodleClient) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return jsonResult(await fn(clientFactory(), args));
    } catch (err) {
      const message = err instanceof MoodleError ? err.message : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  };
}

/**
 * Builds the strictly read-only Moodle MCP server without touching the network
 * or credentials so offline `tools/list` handshakes work before sign-in.
 */
export function createServer(clientFactory: () => MoodleClient = () => MoodleClient.fromEnvironment()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'moodle_get_profile',
    {
      title: 'Get authenticated Moodle user and site info',
      description: 'Read basic identity and site metadata for the signed-in Moodle account. Read-only.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard((client) => client.getSiteInfo(), clientFactory),
  );

  server.registerTool(
    'moodle_list_courses',
    {
      title: 'List enrolled Moodle courses',
      description: 'List Moodle courses for the signed-in user with optional timeline classification and cap.',
      inputSchema: {
        classification: z.enum(['all', 'inprogress', 'future', 'past']).optional().describe('Course timeline filter (default: all).'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of courses to return (default: 50, max: 100).'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { classification?: 'all' | 'inprogress' | 'future' | 'past'; limit?: number }) =>
      client.listCourses(args), clientFactory),
  );

  server.registerTool(
    'moodle_get_course_contents',
    {
      title: 'Get Moodle course sections and resources',
      description: 'Read sections, activities, links, and file metadata in one Moodle course.',
      inputSchema: {
        course_id: z.number().int().positive().describe('Numeric Moodle course ID from moodle_list_courses.'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { course_id: number }) => client.getCourseContents(args.course_id), clientFactory),
  );

  server.registerTool(
    'moodle_list_assignments',
    {
      title: 'List Moodle assignments',
      description: 'List assignments with ISO-8601 UTC due dates across enrolled courses or one specific course.',
      inputSchema: {
        course_id: z.number().int().positive().optional().describe('Optional numeric Moodle course ID to filter by.'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { course_id?: number }) => client.listAssignments(args.course_id), clientFactory),
  );

  server.registerTool(
    'moodle_list_calendar_events',
    {
      title: 'List Moodle calendar events',
      description: 'List bounded upcoming or recent Moodle calendar events with explicit UTC timestamps.',
      inputSchema: {
        days_ahead: z.number().int().min(1).max(90).optional().describe('Days ahead to query (default: 14, max: 90).'),
        days_back: z.number().int().min(0).max(30).optional().describe('Days back to include (default: 0, max: 30).'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of events (default: 50, max: 50).'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { days_ahead?: number; days_back?: number; limit?: number }) =>
      client.listCalendarEvents({ daysAhead: args.days_ahead, daysBack: args.days_back, limit: args.limit }), clientFactory),
  );

  server.registerTool(
    'moodle_list_forums',
    {
      title: 'List Moodle forums and announcement boards',
      description: 'List course forums (including type="news" announcement forums) for enrolled courses or one course.',
      inputSchema: {
        course_id: z.number().int().positive().optional().describe('Optional numeric Moodle course ID to filter by.'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { course_id?: number }) => client.listForums(args.course_id), clientFactory),
  );

  server.registerTool(
    'moodle_list_discussions',
    {
      title: 'List discussions in a Moodle forum',
      description: 'Read bounded discussion topics and excerpts from one Moodle forum (strictly read-only).',
      inputSchema: {
        forum_id: z.number().int().positive().describe('Numeric Moodle forum ID from moodle_list_forums.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum discussions to return (default: 20, max: 50).'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { forum_id: number; limit?: number }) => client.listDiscussions(args.forum_id, args.limit), clientFactory),
  );

  server.registerTool(
    'moodle_get_grades',
    {
      title: 'Get Moodle grade items for a course',
      description: 'Read grade items, scores, percentages, and instructor feedback for the signed-in student in one course.',
      inputSchema: {
        course_id: z.number().int().positive().describe('Numeric Moodle course ID from moodle_list_courses.'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { course_id: number }) => client.getGrades(args.course_id), clientFactory),
  );

  server.registerTool(
    'moodle_list_announcements',
    {
      title: 'List Moodle course announcements',
      description: 'Read recent posts from course announcement (type="news") forums with bounded limits and explicit coverage notes.',
      inputSchema: {
        course_id: z.number().int().positive().optional().describe('Optional numeric Moodle course ID.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum announcements per course (default: 10, max: 25).'),
        max_courses: z.number().int().min(1).max(10).optional().describe('Maximum courses to scan (default: 10, max: 10).'),
      },
      annotations: READ_ONLY,
    },
    guard((client, args: { course_id?: number; limit?: number; max_courses?: number }) =>
      client.listAnnouncements({ courseId: args.course_id, limit: args.limit, maxCourses: args.max_courses }), clientFactory),
  );

  return server;
}
