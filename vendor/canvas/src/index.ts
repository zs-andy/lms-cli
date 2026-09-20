#!/usr/bin/env node
/**
 * Canvas MCP server — brings live UNT Canvas data (courses, assignments, grades,
 * announcements, modules, pages, files, discussions, quizzes, to-dos) into Claude.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  canvasGet,
  canvasGetPaginated,
  canvasDownload,
  baseUrl,
  credentials,
  KEYCHAIN_SERVICE,
} from "./canvas.js";
import { htmlToText, trimQuotedReply } from "./html.js";
import { extractFileText } from "./extract.js";

/**
 * Single source of truth for the version: package.json, one level up from the
 * compiled dist/ file both in the repo and inside node_modules. Hardcoding it
 * here meant it silently drifted every time `npm version` bumped the package.
 */
function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({
  name: "canvas-student-mcp",
  version: packageVersion(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(data: unknown, note?: string): ToolResult {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: note ? `${note}\n${text}` : text }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Wrap a handler so API failures come back as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncNote(truncated: boolean, what: string, cap = 500): string | undefined {
  return truncated
    ? `NOTE: result capped at ${cap} ${what}; narrow the query (course, dates, search) for the rest.`
    : undefined;
}

// --- slimming helpers: return only fields an assistant actually needs -------

function slimCourse(c: any) {
  return {
    id: c.id,
    name: c.name,
    course_code: c.course_code,
    term: c.term?.name,
    start_at: c.start_at,
    end_at: c.end_at,
    workflow_state: c.workflow_state,
    current_score: c.enrollments?.[0]?.computed_current_score ?? null,
    current_grade: c.enrollments?.[0]?.computed_current_grade ?? null,
  };
}

function slimSubmission(s: any) {
  if (!s) return null;
  return {
    workflow_state: s.workflow_state,
    submitted_at: s.submitted_at,
    score: s.score,
    grade: s.grade,
    late: s.late,
    missing: s.missing,
    excused: s.excused,
  };
}

function slimAssignment(a: any, includeDescription = false) {
  return {
    id: a.id,
    name: a.name,
    due_at: a.due_at,
    unlock_at: a.unlock_at,
    lock_at: a.lock_at,
    points_possible: a.points_possible,
    submission_types: a.submission_types,
    has_submitted: a.has_submitted_submissions,
    html_url: a.html_url,
    ...(includeDescription ? { description: htmlToText(a.description, 3000) } : {}),
    submission: slimSubmission(a.submission),
  };
}

/** Context codes (course_123) for the user's active courses. */
async function activeCourseContextCodes(): Promise<{ codes: string[]; names: Record<string, string> }> {
  const { items } = await canvasGetPaginated("/courses", {
    enrollment_state: "active",
    "state[]": ["available"],
  });
  const names: Record<string, string> = {};
  const codes = items.map((c: any) => {
    names[`course_${c.id}`] = c.name;
    return `course_${c.id}`;
  });
  return { codes, names };
}

// ---------------------------------------------------------------------------
// Identity / sanity check
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_auth_status",
  {
    title: "Check credential status",
    description:
      "Diagnose the Canvas connection: which credential is in use, where it's stored, and whether it still works. " +
      "Run this first when something fails, or before a scheduled job, to distinguish an expired session from a real error.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  // Deliberately not wrapped in safe(): this tool reports failures as its
  // result rather than erroring, so it stays useful when auth is broken.
  async () => {
    const url = process.env.CANVAS_BASE_URL;
    const creds = credentials();
    const method = creds.token ? "API token" : creds.cookie ? "session cookie" : "none";

    const report: Record<string, unknown> = {
      canvas_url: url ?? "(CANVAS_BASE_URL not set)",
      auth_method: method,
      credential_source: creds.source,
    };

    if (!url) {
      report.status = "not_configured";
      report.action_required =
        "Set CANVAS_BASE_URL to your school's Canvas domain (e.g. https://unt.instructure.com).";
      return jsonResult(report);
    }
    if (creds.source === "none") {
      report.status = "not_configured";
      report.action_required =
        `No credential found. Set CANVAS_COOKIE or CANVAS_API_TOKEN in the MCP config, or store one in the Keychain: ` +
        `security add-generic-password -s ${KEYCHAIN_SERVICE} -a cookie -w '<value>' -U`;
      return jsonResult(report);
    }

    // A cookie header without canvas_session is the most common paste mistake.
    if (creds.cookie && !/(^|;|\s)canvas_session=/.test(creds.cookie)) {
      report.warning =
        "The cookie value does not contain a 'canvas_session=' pair. Copy the full cookie header, " +
        "or at minimum the canvas_session=... pair.";
    }

    try {
      const p = await canvasGet("/users/self/profile");
      report.status = "ok";
      report.authenticated_as = { id: p.id, name: p.name, login_id: p.login_id };
      if (creds.cookie) {
        report.note =
          "Session cookies expire when the browser session ends. If calls start failing, re-copy the cookie.";
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.status = /expired|redirect|401|non-JSON/i.test(message) ? "expired" : "error";
      report.detail = message;
      report.action_required = creds.token
        ? `Generate a new access token at ${baseUrl()}/profile/settings and update the MCP config.`
        : `Log into ${baseUrl()} in your browser, re-copy the 'cookie:' header from DevTools → Network, ` +
          `and update ${creds.source === "macOS Keychain" ? `the Keychain entry: security add-generic-password -s ${KEYCHAIN_SERVICE} -a cookie -w '<new value>' -U` : "CANVAS_COOKIE in the MCP config"}.`;
    }

    return jsonResult(report);
  }
);

server.registerTool(
  "canvas_get_profile",
  {
    title: "Get my Canvas profile",
    description:
      "Fetch the authenticated user's Canvas profile (name, primary email, id). Use this to verify the API token works.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  safe(async () => {
    const p = await canvasGet("/users/self/profile");
    return jsonResult({ id: p.id, name: p.name, primary_email: p.primary_email, login_id: p.login_id, canvas: baseUrl() });
  })
);

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_courses",
  {
    title: "List my courses",
    description:
      "List the user's Canvas courses with current score/grade per course. state='active' (default) for this semester, 'completed' for past courses, 'all' for everything.",
    inputSchema: {
      state: z.enum(["active", "completed", "all"]).optional().describe("Enrollment state filter; default 'active'"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ state }) => {
    const params: Record<string, any> = {
      "include[]": ["term", "total_scores"],
    };
    if (state !== "all") params.enrollment_state = state ?? "active";
    const { items, truncated } = await canvasGetPaginated("/courses", params);
    return jsonResult(items.map(slimCourse), truncNote(truncated, "courses"));
  })
);

server.registerTool(
  "canvas_get_course",
  {
    title: "Get course details + syllabus",
    description:
      "Get one course's details including the full syllabus text, term, and current score. course_id comes from canvas_list_courses.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    const c = await canvasGet(`/courses/${course_id}`, {
      "include[]": ["syllabus_body", "term", "total_scores", "teachers"],
    });
    return jsonResult({
      ...slimCourse(c),
      teachers: (c.teachers ?? []).map((t: any) => t.display_name),
      syllabus: htmlToText(c.syllabus_body, 30000) || "(no syllabus posted)",
    });
  })
);

// ---------------------------------------------------------------------------
// Assignments & grades
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_assignments",
  {
    title: "List assignments",
    description:
      "List a course's assignments ordered by due date, each with the user's submission status (submitted/score/late/missing). " +
      "Optional bucket filters: upcoming, past, overdue, undated, ungraded, unsubmitted, future.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      bucket: z
        .enum(["upcoming", "past", "overdue", "undated", "ungraded", "unsubmitted", "future"])
        .optional()
        .describe("Filter assignments by due-date/submission bucket"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, bucket }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/assignments`, {
      "include[]": ["submission"],
      order_by: "due_at",
      bucket,
    });
    return jsonResult(items.map((a: any) => slimAssignment(a)), truncNote(truncated, "assignments"));
  })
);

server.registerTool(
  "canvas_get_assignment",
  {
    title: "Get assignment details",
    description:
      "Get one assignment's full details: description (as text), due/lock dates, rubric, and the user's submission with score and grade.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      assignment_id: z.number().describe("Canvas assignment ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, assignment_id }) => {
    const a = await canvasGet(`/courses/${course_id}/assignments/${assignment_id}`, {
      "include[]": ["submission"],
    });
    const rubric = (a.rubric ?? []).map((r: any) => ({
      criterion: r.description,
      points: r.points,
    }));
    return jsonResult({
      ...slimAssignment(a, true),
      ...(rubric.length ? { rubric } : {}),
    });
  })
);

server.registerTool(
  "canvas_get_grades",
  {
    title: "Get grades",
    description:
      "Without course_id: current score/grade for every active course. With course_id: every graded submission in that course " +
      "(assignment name, score, points possible, late/missing flags) — useful for 'what's my grade breakdown'.",
    inputSchema: {
      course_id: z.number().optional().describe("Canvas course ID; omit for all-course overview"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    if (course_id === undefined) {
      const { items } = await canvasGetPaginated("/courses", {
        enrollment_state: "active",
        "include[]": ["total_scores", "term"],
      });
      return jsonResult(
        items.map((c: any) => ({
          course_id: c.id,
          course: c.name,
          term: c.term?.name,
          current_score: c.enrollments?.[0]?.computed_current_score ?? null,
          current_grade: c.enrollments?.[0]?.computed_current_grade ?? null,
          final_score: c.enrollments?.[0]?.computed_final_score ?? null,
        }))
      );
    }
    const { items, truncated } = await canvasGetPaginated(
      `/courses/${course_id}/students/submissions`,
      {
        "student_ids[]": ["self"],
        "include[]": ["assignment"],
      }
    );
    const rows = items.map((s: any) => ({
      assignment_id: s.assignment_id,
      assignment: s.assignment?.name,
      due_at: s.assignment?.due_at,
      points_possible: s.assignment?.points_possible,
      score: s.score,
      grade: s.grade,
      workflow_state: s.workflow_state,
      late: s.late,
      missing: s.missing,
      excused: s.excused,
    }));
    return jsonResult(rows, truncNote(truncated, "submissions"));
  })
);

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_announcements",
  {
    title: "List announcements",
    description:
      "List announcements. Defaults to all active courses over the last 30 days; pass course_id and/or start_date (ISO) to narrow or widen.",
    inputSchema: {
      course_id: z.number().optional().describe("Limit to one course"),
      start_date: z.string().optional().describe("ISO date (YYYY-MM-DD); default 30 days ago"),
      end_date: z.string().optional().describe("ISO date (YYYY-MM-DD); default today"),
      max_chars: z.number().int().min(2000).max(100000).optional().describe("Maximum body characters per announcement; default 20000. Truncation is marked."),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, start_date, end_date, max_chars }) => {
    let codes: string[];
    let names: Record<string, string> = {};
    if (course_id !== undefined) {
      codes = [`course_${course_id}`];
    } else {
      ({ codes, names } = await activeCourseContextCodes());
    }
    if (codes.length === 0) return textResult("No active courses found.");

    const { items, truncated } = await canvasGetPaginated("/announcements", {
      "context_codes[]": codes,
      start_date: start_date ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      end_date: end_date ?? new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    });
    const rows = items.map((a: any) => ({
      id: a.id,
      course: names[a.context_code] ?? a.context_code,
      title: a.title,
      posted_at: a.posted_at,
      updated_at: a.updated_at,
      source_url: a.html_url ?? `${baseUrl()}/courses/${String(a.context_code).replace('course_', '')}/discussion_topics/${a.id}`,
      author: a.user_name ?? a.author?.display_name,
      message: htmlToText(a.message, max_chars ?? 20000),
    }));
    return jsonResult(rows, truncNote(truncated, "announcements"));
  })
);

// ---------------------------------------------------------------------------
// Modules & pages
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_modules",
  {
    title: "List modules",
    description:
      "List a course's modules with their items (pages, files, assignments, quizzes, links) in order — the course's content outline.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/modules`, {
      "include[]": ["items"],
    });
    const rows = items.map((m: any) => ({
      id: m.id,
      name: m.name,
      state: m.state,
      items: (m.items ?? []).map((i: any) => ({
        type: i.type,
        title: i.title,
        // content_id for Files/Assignments/Quizzes; page_url for Pages
        content_id: i.content_id,
        page_url: i.page_url,
        html_url: i.html_url,
      })),
    }));
    return jsonResult(rows, truncNote(truncated, "modules"));
  })
);

server.registerTool(
  "canvas_list_pages",
  {
    title: "List course pages",
    description: "List a course's wiki pages. Use search_term to filter by title.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      search_term: z.string().optional().describe("Filter pages by title"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, search_term }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/pages`, {
      search_term,
      sort: "title",
    });
    const rows = items.map((p: any) => ({
      page_id: p.page_id,
      url: p.url,
      title: p.title,
      updated_at: p.updated_at,
    }));
    return jsonResult(rows, truncNote(truncated, "pages"));
  })
);

server.registerTool(
  "canvas_get_page",
  {
    title: "Read a course page",
    description:
      "Read one course page's full content as text. page_url is the 'url' slug from canvas_list_pages or canvas_list_modules.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      page_url: z.string().describe("Page URL slug (e.g. 'week-1-overview') or page ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, page_url }) => {
    const p = await canvasGet(`/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
    return jsonResult({
      title: p.title,
      updated_at: p.updated_at,
      body: htmlToText(p.body, 15000),
    });
  })
);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_files",
  {
    title: "List course files",
    description:
      "List files in a course (slides, PDFs, handouts). Use search_term to filter by name. Returns file IDs for canvas_get_file_link.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      search_term: z.string().optional().describe("Filter files by name"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, search_term }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/files`, {
      search_term,
      sort: "updated_at",
      order: "desc",
    });
    const rows = items.map((f: any) => ({
      id: f.id,
      filename: f.display_name,
      content_type: f["content-type"],
      size_kb: Math.round((f.size ?? 0) / 1024),
      updated_at: f.updated_at,
    }));
    return jsonResult(rows, truncNote(truncated, "files"));
  })
);

server.registerTool(
  "canvas_get_file_link",
  {
    title: "Get file download link",
    description:
      "Get a temporary authenticated download URL for a file (file_id from canvas_list_files or module items). The URL expires, so use it promptly.",
    inputSchema: {
      file_id: z.number().describe("Canvas file ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ file_id }) => {
    const f = await canvasGet(`/files/${file_id}`);
    return jsonResult({
      filename: f.display_name,
      content_type: f["content-type"],
      size_kb: Math.round((f.size ?? 0) / 1024),
      download_url: f.url,
      note: "URL is time-limited; download promptly.",
    });
  })
);

// ---------------------------------------------------------------------------
// Discussions & quizzes
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_discussions",
  {
    title: "List discussions",
    description: "List a course's discussion topics with unread counts and due dates.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    const { items, truncated } = await canvasGetPaginated(
      `/courses/${course_id}/discussion_topics`,
      { order_by: "recent_activity" }
    );
    const rows = items.map((d: any) => ({
      id: d.id,
      title: d.title,
      posted_at: d.posted_at,
      due_at: d.assignment?.due_at ?? d.lock_at,
      unread_count: d.unread_count,
      reply_count: d.discussion_subentry_count,
      message: htmlToText(d.message, 1000),
    }));
    return jsonResult(rows, truncNote(truncated, "discussions"));
  })
);

server.registerTool(
  "canvas_get_discussion",
  {
    title: "Read a discussion thread",
    description: "Read a discussion topic's full thread, including replies.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      topic_id: z.number().describe("Discussion topic ID from canvas_list_discussions"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, topic_id }) => {
    const view = await canvasGet(`/courses/${course_id}/discussion_topics/${topic_id}/view`);
    const participants: Record<number, string> = {};
    for (const p of view.participants ?? []) participants[p.id] = p.display_name;

    const flatten = (entries: any[]): any[] =>
      (entries ?? []).flatMap((e: any) => [
        {
          author: participants[e.user_id] ?? `user ${e.user_id}`,
          posted_at: e.created_at,
          message: htmlToText(e.message, 1500),
        },
        ...flatten(e.replies ?? []),
      ]);

    return jsonResult(flatten(view.view ?? []));
  })
);

server.registerTool(
  "canvas_list_quizzes",
  {
    title: "List quizzes",
    description: "List a course's quizzes with due dates, time limits, allowed attempts, and points.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/quizzes`);
    const rows = items.map((q: any) => ({
      id: q.id,
      title: q.title,
      due_at: q.due_at,
      unlock_at: q.unlock_at,
      lock_at: q.lock_at,
      time_limit_minutes: q.time_limit,
      allowed_attempts: q.allowed_attempts,
      points_possible: q.points_possible,
      question_count: q.question_count,
      html_url: q.html_url,
    }));
    return jsonResult(rows, truncNote(truncated, "quizzes"));
  })
);

// ---------------------------------------------------------------------------
// Planner: to-do, upcoming, calendar
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_todo",
  {
    title: "My to-do list",
    description: "The user's Canvas to-do list: assignments and quizzes needing submission, across all courses.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  safe(async () => {
    const { items } = await canvasGetPaginated("/users/self/todo");
    const rows = items.map((t: any) => ({
      type: t.type,
      course_id: t.course_id,
      assignment: t.assignment?.name ?? t.quiz?.title,
      due_at: t.assignment?.due_at ?? t.quiz?.due_at,
      points_possible: t.assignment?.points_possible ?? t.quiz?.points_possible,
      html_url: t.html_url,
    }));
    return jsonResult(rows);
  })
);

server.registerTool(
  "canvas_list_upcoming",
  {
    title: "Upcoming events",
    description: "The user's upcoming Canvas events and assignment due dates across all courses (next ~2 weeks).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  safe(async () => {
    const items = await canvasGet("/users/self/upcoming_events");
    const rows = (items as any[]).map((e: any) => ({
      title: e.title,
      type: e.assignment ? "assignment" : "event",
      start_at: e.start_at ?? e.assignment?.due_at,
      context: e.context_name,
      html_url: e.html_url,
    }));
    return jsonResult(rows);
  })
);

server.registerTool(
  "canvas_list_calendar_events",
  {
    title: "Calendar events",
    description:
      "Calendar events (lectures, office hours, deadlines) between two dates. type='assignment' shows assignment due dates instead of plain events.",
    inputSchema: {
      start_date: z.string().describe("ISO date YYYY-MM-DD"),
      end_date: z.string().describe("ISO date YYYY-MM-DD"),
      course_id: z.number().optional().describe("Limit to one course; default all active courses"),
      type: z.enum(["event", "assignment"]).optional().describe("Default 'event'"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ start_date, end_date, course_id, type }) => {
    let codes: string[];
    let names: Record<string, string> = {};
    if (course_id !== undefined) {
      codes = [`course_${course_id}`];
    } else {
      ({ codes, names } = await activeCourseContextCodes());
    }
    const items: any[] = [];
    let truncated = false;
    // Canvas permits at most ten contexts per request, not ten courses per account.
    for (let offset = 0; offset < codes.length; offset += 10) {
      const page = await canvasGetPaginated("/calendar_events", {
        type: type ?? "event", start_date, end_date,
        "context_codes[]": codes.slice(offset, offset + 10),
      });
      items.push(...page.items); truncated ||= page.truncated;
    }
    const rows = items.map((e: any) => ({
      id: e.id,
      source_url: e.html_url ?? e.assignment?.html_url,
      title: e.title,
      start_at: e.start_at ?? e.assignment?.due_at,
      end_at: e.end_at,
      course: names[e.context_code] ?? e.context_name ?? e.context_code,
      location: e.location_name,
      description: htmlToText(e.description, 500),
    }));
    return jsonResult(rows, truncNote(truncated, "events"));
  })
);

// ---------------------------------------------------------------------------
// Inbox (conversations)
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_inbox",
  {
    title: "List Canvas inbox messages",
    description:
      "List conversations from the Canvas inbox (messages from instructors, TAs, and classmates) with sender, course, " +
      "preview, and read state. Use scope='unread' for just unread messages.",
    inputSchema: {
      scope: z
        .enum(["inbox", "unread", "starred", "sent", "archived"])
        .optional()
        .describe("Which mailbox to list; default 'inbox'"),
      limit: z.number().min(1).max(50).optional().describe("Max conversations to return; default 20"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ scope, limit }) => {
    const { items, truncated } = await canvasGetPaginated(
      "/conversations",
      { scope: scope && scope !== "inbox" ? scope : undefined, per_page: limit ?? 20 },
      1
    );
    const me = await canvasGet("/users/self/profile").catch(() => null);
    const rows = items.slice(0, limit ?? 20).map((c: any) => ({
      id: c.id,
      subject: c.subject,
      course: c.context_name,
      // Drop self from the participant list — the interesting party is the other person.
      with: (c.participants ?? [])
        .filter((p: any) => !me || p.id !== me.id)
        .map((p: any) => p.full_name ?? p.name),
      unread: c.workflow_state === "unread",
      starred: c.starred,
      message_count: c.message_count,
      last_message_at: c.last_message_at,
      preview: c.last_message,
    }));
    return jsonResult(rows, truncNote(truncated, "conversations", limit ?? 20));
  })
);

server.registerTool(
  "canvas_get_conversation",
  {
    title: "Read a conversation thread",
    description:
      "Read the full message thread of one conversation, including every reply. Does NOT mark the conversation as read.",
    inputSchema: {
      conversation_id: z.number().describe("Conversation ID from canvas_list_inbox"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ conversation_id }) => {
    // auto_mark_as_read=false keeps this tool genuinely read-only; Canvas would
    // otherwise flip the conversation to read as a side effect of fetching it.
    const c = await canvasGet(`/conversations/${conversation_id}`, { auto_mark_as_read: false });
    const names: Record<number, string> = {};
    for (const p of c.participants ?? []) names[p.id] = p.full_name ?? p.name;
    return jsonResult({
      id: c.id,
      subject: c.subject,
      course: c.context_name,
      participants: Object.values(names),
      messages: (c.messages ?? []).map((m: any) => ({
        from: names[m.author_id] ?? `user ${m.author_id}`,
        sent_at: m.created_at,
        body: trimQuotedReply(m.body),
        attachments: (m.attachments ?? []).map((a: any) => a.display_name),
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// Grader feedback
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_get_feedback",
  {
    title: "Get grader feedback",
    description:
      "Get grader comments and rubric assessments on your submissions — what the instructor or TA actually wrote. " +
      "Omit course_id to check every active course. Only returns submissions that have feedback or a grade.",
    inputSchema: {
      course_id: z.number().optional().describe("Limit to one course; default all active courses"),
      include_empty: z
        .boolean()
        .optional()
        .describe("Include submissions with no feedback and no grade; default false"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, include_empty }) => {
    let courses: Array<{ id: number; name: string }>;
    if (course_id !== undefined) {
      courses = [{ id: course_id, name: `course ${course_id}` }];
    } else {
      const { items } = await canvasGetPaginated("/courses", { enrollment_state: "active" });
      courses = items.map((c: any) => ({ id: c.id, name: c.name }));
    }

    const out: any[] = [];
    for (const course of courses) {
      let items: any[] = [];
      try {
        ({ items } = await canvasGetPaginated(
          `/courses/${course.id}/students/submissions`,
          {
            "student_ids[]": ["self"],
            "include[]": ["submission_comments", "rubric_assessment", "assignment"],
          },
          2
        ));
      } catch {
        continue; // course may restrict submissions; skip quietly
      }

      for (const s of items) {
        const comments = (s.submission_comments ?? []).map((c: any) => ({
          from: c.author_name,
          at: c.created_at,
          comment: c.comment,
        }));

        // rubric_assessment is keyed by criterion id; map ids to their descriptions.
        const criteria: Record<string, any> = {};
        for (const c of s.assignment?.rubric ?? []) criteria[c.id] = c;
        const rubric = Object.entries(s.rubric_assessment ?? {}).map(([id, a]: [string, any]) => ({
          criterion: criteria[id]?.description ?? id,
          points: a?.points ?? null,
          out_of: criteria[id]?.points ?? null,
          comment: a?.comments || undefined,
        }));

        const hasFeedback = comments.length > 0 || rubric.length > 0 || s.score != null;
        if (!hasFeedback && !include_empty) continue;

        out.push({
          course: course.name,
          assignment: s.assignment?.name,
          assignment_id: s.assignment_id,
          score: s.score,
          grade: s.grade,
          points_possible: s.assignment?.points_possible,
          graded_at: s.graded_at,
          late: s.late,
          missing: s.missing,
          ...(comments.length ? { comments } : {}),
          ...(rubric.length ? { rubric } : {}),
        });
      }
    }

    if (out.length === 0) {
      return textResult(
        "No grader feedback yet — nothing has been graded, and no comments have been left on your submissions."
      );
    }
    return jsonResult(out);
  })
);

// ---------------------------------------------------------------------------
// Grade breakdown / what-if calculator
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_grade_breakdown",
  {
    title: "Grade breakdown & what-if calculator",
    description:
      "Break a course grade down by assignment group (with weights), showing what's graded, what's left, and your current standing. " +
      "Pass target_grade (e.g. 90) to compute the average you need on all remaining work to finish at that grade.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      target_grade: z
        .number()
        .min(0)
        .max(150)
        .optional()
        .describe("Desired final percentage, e.g. 90 for an A"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, target_grade }) => {
    const [course, groupsRes] = await Promise.all([
      canvasGet(`/courses/${course_id}`, { "include[]": ["total_scores"] }),
      canvasGetPaginated(`/courses/${course_id}/assignment_groups`, {
        "include[]": ["assignments", "submission"],
      }),
    ]);

    const weighted = course.apply_assignment_group_weights === true;
    const caveats: string[] = [];

    const groups = groupsRes.items.map((g: any) => {
      let earned = 0;
      let gradedPossible = 0;
      let remaining = 0;

      for (const a of g.assignments ?? []) {
        // Mirror Canvas's own exclusions from the final grade.
        if (a.omit_from_final_grade || a.published === false || a.hide_in_gradebook) continue;
        const pts = a.points_possible ?? 0;
        if (pts <= 0) continue;
        const s = a.submission;
        if (s?.excused) continue;
        if (s && s.workflow_state === "graded" && s.score != null) {
          earned += s.score;
          gradedPossible += pts;
        } else {
          remaining += pts;
        }
      }

      return {
        name: g.name,
        weight: weighted ? g.group_weight : null,
        earned,
        graded_possible: gradedPossible,
        remaining_points: remaining,
        percentage: gradedPossible > 0 ? round2((earned / gradedPossible) * 100) : null,
      };
    });

    const totalGradedPossible = groups.reduce((n, g) => n + g.graded_possible, 0);
    const totalEarned = groups.reduce((n, g) => n + g.earned, 0);
    const totalRemaining = groups.reduce((n, g) => n + g.remaining_points, 0);

    // ---- current standing --------------------------------------------------
    let current: number | null = null;
    if (weighted) {
      // Canvas normalizes weights across groups that actually have graded work.
      const active = groups.filter((g) => g.graded_possible > 0 && (g.weight ?? 0) > 0);
      const weightSum = active.reduce((n, g) => n + (g.weight ?? 0), 0);
      if (weightSum > 0) {
        current = round2(
          active.reduce((n, g) => n + (g.weight ?? 0) * (g.earned / g.graded_possible), 0) / weightSum * 100
        );
      }
    } else if (totalGradedPossible > 0) {
      current = round2((totalEarned / totalGradedPossible) * 100);
    }

    const canvasScore = course.enrollments?.[0]?.computed_current_score ?? null;
    if (current != null && canvasScore != null && Math.abs(current - canvasScore) > 0.6) {
      caveats.push(
        `Computed current grade (${current}%) differs from the score Canvas reports (${canvasScore}%). ` +
          "Canvas may apply drop rules or late penalties this calculation doesn't model — trust Canvas for the official number."
      );
    }
    if (weighted) {
      const emptyWeighted = groups.filter((g) => (g.weight ?? 0) > 0 && g.graded_possible + g.remaining_points === 0);
      if (emptyWeighted.length) {
        caveats.push(
          `These weighted groups have no assignments posted yet: ${emptyWeighted.map((g) => `${g.name} (${g.weight}%)`).join(", ")}. ` +
            "Projections will shift once the instructor posts them."
        );
      }
    }
    if (groupsRes.items.some((g: any) => Object.keys(g.rules ?? {}).length > 0)) {
      caveats.push("One or more groups have drop/keep rules (e.g. drop lowest score) that this calculation ignores.");
    }

    // ---- what-if -----------------------------------------------------------
    let whatIf: any = undefined;
    if (target_grade !== undefined) {
      if (totalRemaining <= 0) {
        whatIf = {
          target: target_grade,
          achievable: current != null ? current >= target_grade : null,
          note: "No ungraded work remains, so the grade can no longer change.",
        };
      } else if (weighted) {
        // final = A + B*p, where p is the uniform fraction earned on remaining work.
        const contributing = groups.filter(
          (g) => (g.weight ?? 0) > 0 && g.graded_possible + g.remaining_points > 0
        );
        const weightSum = contributing.reduce((n, g) => n + (g.weight ?? 0), 0);
        let A = 0;
        let B = 0;
        for (const g of contributing) {
          const total = g.graded_possible + g.remaining_points;
          A += (g.weight ?? 0) * (g.earned / total);
          B += (g.weight ?? 0) * (g.remaining_points / total);
        }
        A = (A / weightSum) * 100;
        B = B / weightSum;
        const needed = B > 0 ? (target_grade - A) / B : null;
        whatIf = {
          target: target_grade,
          needed_average_on_remaining_percent: needed == null ? null : round2(needed),
          achievable: needed == null ? null : needed <= 100,
          note:
            needed == null
              ? "No remaining weighted work to model."
              : needed <= 0
                ? "Already secured — even a zero on everything remaining keeps you at or above the target."
                : needed > 100
                  ? "Not reachable with perfect scores on the remaining work as currently posted."
                  : `Average ${round2(needed)}% across all remaining graded work to finish at ${target_grade}%.`,
        };
      } else {
        const totalPossible = totalGradedPossible + totalRemaining;
        const pointsNeeded = (target_grade / 100) * totalPossible - totalEarned;
        const needed = (pointsNeeded / totalRemaining) * 100;
        whatIf = {
          target: target_grade,
          points_needed_from_remaining: round2(pointsNeeded),
          remaining_points: totalRemaining,
          needed_average_on_remaining_percent: round2(needed),
          achievable: needed <= 100,
          note:
            needed <= 0
              ? "Already secured — even a zero on everything remaining keeps you at or above the target."
              : needed > 100
                ? "Not reachable with perfect scores on the remaining work as currently posted."
                : `Earn ${round2(pointsNeeded)} of the ${totalRemaining} remaining points (${round2(needed)}% average).`,
        };
      }
    }

    return jsonResult({
      course: course.name,
      grading_mode: weighted ? "weighted by assignment group" : "total points",
      current_grade_computed: current,
      canvas_reported_current_score: canvasScore,
      canvas_reported_current_grade: course.enrollments?.[0]?.computed_current_grade ?? null,
      groups: groups.map((g) => ({
        name: g.name,
        ...(weighted ? { weight_percent: g.weight } : {}),
        graded: g.graded_possible > 0 ? `${round2(g.earned)}/${g.graded_possible}` : "nothing graded yet",
        percentage: g.percentage,
        ungraded_points_remaining: g.remaining_points,
      })),
      totals: {
        earned: round2(totalEarned),
        graded_points_possible: totalGradedPossible,
        ungraded_points_remaining: totalRemaining,
      },
      ...(whatIf ? { what_if: whatIf } : {}),
      ...(caveats.length ? { caveats } : {}),
    });
  })
);

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_planner",
  {
    title: "Planner feed",
    description:
      "Canvas planner feed across all courses — assignments, quizzes, discussions, announcements, and calendar events " +
      "in date order, each flagged with whether it has new activity and your submission state. Richer than canvas_list_todo.",
    inputSchema: {
      days_ahead: z.number().min(1).max(120).optional().describe("How far forward to look; default 14"),
      days_back: z.number().min(0).max(60).optional().describe("How far back to include; default 0"),
      new_activity_only: z.boolean().optional().describe("Only items Canvas flags as having new activity"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ days_ahead, days_back, new_activity_only }) => {
    const day = 86400_000;
    const start = new Date(Date.now() - (days_back ?? 0) * day).toISOString().slice(0, 10);
    const end = new Date(Date.now() + (days_ahead ?? 14) * day).toISOString().slice(0, 10);

    const { items, truncated } = await canvasGetPaginated("/planner/items", {
      start_date: start,
      end_date: end,
    });

    const rows = items
      .filter((i: any) => !new_activity_only || i.new_activity)
      .map((i: any) => {
        const sub = i.submissions;
        return {
          type: i.plannable_type,
          title: i.plannable?.title ?? i.plannable?.name,
          date: i.plannable_date,
          course: i.context_name,
          course_id: i.course_id,
          points_possible: i.plannable?.points_possible ?? undefined,
          new_activity: i.new_activity || undefined,
          status: sub
            ? sub.missing
              ? "missing"
              : sub.graded
                ? "graded"
                : sub.submitted
                  ? "submitted"
                  : sub.late
                    ? "late"
                    : "not submitted"
            : undefined,
          url: i.html_url ? `${baseUrl()}${i.html_url}` : undefined,
        };
      });

    if (rows.length === 0) {
      return textResult(
        `Nothing in the planner between ${start} and ${end}` +
          (new_activity_only ? " with new activity." : ".")
      );
    }
    return jsonResult(rows, truncNote(truncated, "planner items"));
  })
);

// ---------------------------------------------------------------------------
// File content extraction
// ---------------------------------------------------------------------------

const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/** Fetch a Canvas file's bytes via its (time-limited, pre-authenticated) URL. */
async function downloadFile(meta: any): Promise<Buffer> {
  const size = meta.size ?? 0;
  if (size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `File is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit. ` +
        "Use canvas_get_file_link to download it directly instead."
    );
  }
  return canvasDownload(meta.url);
}

server.registerTool(
  "canvas_read_file",
  {
    title: "Read a course file's text",
    description:
      "Download a Canvas file and extract its text — PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), HTML, and " +
      "plain-text formats. Use this to read syllabi, lecture slides, and handouts. file_id comes from canvas_list_files " +
      "or a module item's content_id.",
    inputSchema: {
      file_id: z.number().describe("Canvas file ID"),
      max_chars: z.number().min(500).max(100000).optional().describe("Cap on returned text; default 20000"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ file_id, max_chars }) => {
    const meta = await canvasGet(`/files/${file_id}`);
    const buf = await downloadFile(meta);
    const { text, kind, truncated } = await extractFileText(
      buf,
      meta.display_name ?? meta.filename ?? "",
      meta["content-type"],
      max_chars ?? 20000
    );
    return textResult(
      `# ${meta.display_name}\n` +
        `_${kind} · ${Math.round((meta.size ?? 0) / 1024)}KB${truncated ? " · truncated" : ""}_\n\n${text}`
    );
  })
);

server.registerTool(
  "canvas_read_syllabus",
  {
    title: "Read a course syllabus (inline or attached file)",
    description:
      "Get a course's syllabus as text. Handles both cases automatically: syllabus typed into Canvas, or posted as an " +
      "attached PDF/Word file (common) — in which case the file is downloaded and its text extracted.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      max_chars: z.number().min(500).max(100000).optional().describe("Cap on returned text; default 30000"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, max_chars }) => {
    const cap = max_chars ?? 30000;
    const course = await canvasGet(`/courses/${course_id}`, {
      "include[]": ["syllabus_body", "teachers"],
    });
    const body: string = course.syllabus_body ?? "";
    const inline = htmlToText(body, cap);

    // A syllabus that is only a file link renders as a short blob of text with
    // a /files/<id> href — detect that and read the attachment instead.
    const fileId = body.match(/\/(?:courses\/\d+\/)?files\/(\d+)/)?.[1];
    const looksLikeLinkOnly = inline.length < 400 && !!fileId;

    if (!looksLikeLinkOnly) {
      if (!inline) return textResult(`No syllabus posted for ${course.name}.`);
      return textResult(`# Syllabus — ${course.name}\n\n${inline}`);
    }

    try {
      const meta = await canvasGet(`/files/${fileId}`, { location: `course_syllabus_${course_id}` });
      const buf = await downloadFile(meta);
      const { text, kind } = await extractFileText(
        buf,
        meta.display_name ?? "",
        meta["content-type"],
        cap
      );
      return textResult(
        `# Syllabus — ${course.name}\n` +
          `_Extracted from attached file: ${meta.display_name} (${kind})_\n\n${text}`
      );
    } catch (e) {
      return textResult(
        `The syllabus for ${course.name} is posted as an attached file (id ${fileId}), but it could not be read: ` +
          `${e instanceof Error ? e.message : String(e)}\n\nCanvas page: ${baseUrl()}/courses/${course_id}/assignments/syllabus`
      );
    }
  })
);

// ---------------------------------------------------------------------------
// Groups, module progress, peer reviews
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_list_groups",
  {
    title: "List my groups",
    description:
      "List the Canvas groups you belong to (project teams, study groups, sections) with member counts and their course.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  safe(async () => {
    const { items } = await canvasGetPaginated("/users/self/groups");
    if (!items.length) return textResult("You are not a member of any Canvas groups.");
    return jsonResult(
      items.map((g: any) => ({
        id: g.id,
        name: g.name,
        course_id: g.course_id,
        context: g.context_type,
        members: g.members_count,
        description: htmlToText(g.description, 400) || undefined,
      }))
    );
  })
);

server.registerTool(
  "canvas_get_module_progress",
  {
    title: "Module completion progress",
    description:
      "Show module-by-module progress: which modules are locked, started, or completed, and for each item what Canvas " +
      "requires to mark it done (view it, submit it, contribute, or score a minimum) and whether you've done it.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      incomplete_only: z.boolean().optional().describe("Only show items you still need to complete"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, incomplete_only }) => {
    const { items, truncated } = await canvasGetPaginated(`/courses/${course_id}/modules`, {
      "include[]": ["items", "content_details"],
    });

    const describeRequirement = (r: any): string | undefined => {
      if (!r) return undefined;
      switch (r.type) {
        case "must_view":
          return "view it";
        case "must_submit":
          return "submit it";
        case "must_contribute":
          return "post a contribution";
        case "must_mark_done":
          return "mark it done";
        case "min_score":
          return `score at least ${r.min_score}`;
        default:
          return r.type;
      }
    };

    const rows = items
      .map((m: any) => {
        const modItems = (m.items ?? [])
          .map((i: any) => ({
            type: i.type,
            title: i.title,
            requirement: describeRequirement(i.completion_requirement),
            completed: i.completion_requirement ? Boolean(i.completion_requirement.completed) : undefined,
            due_at: i.content_details?.due_at ?? undefined,
            points_possible: i.content_details?.points_possible ?? undefined,
            locked: i.content_details?.locked_for_user || undefined,
            url: i.html_url,
          }))
          .filter((i: any) => !incomplete_only || (i.requirement && !i.completed));

        const required = (m.items ?? []).filter((i: any) => i.completion_requirement);
        const done = required.filter((i: any) => i.completion_requirement.completed);

        return {
          module: m.name,
          state: m.state ?? "no requirements",
          completed_at: m.completed_at ?? undefined,
          progress: required.length ? `${done.length}/${required.length} requirements met` : undefined,
          unlock_at: m.unlock_at ?? undefined,
          sequential: m.require_sequential_progress || undefined,
          items: modItems,
        };
      })
      .filter((m: any) => !incomplete_only || m.items.length > 0);

    if (!rows.length) {
      return textResult(
        incomplete_only
          ? "No outstanding module requirements — everything with a completion requirement is done."
          : "This course has no modules."
      );
    }
    return jsonResult(rows, truncNote(truncated, "modules"));
  })
);

server.registerTool(
  "canvas_list_peer_reviews",
  {
    title: "List peer reviews assigned to me",
    description:
      "Find peer reviews you've been asked to complete, and their status. Scans the course's peer-review assignments; " +
      "pass assignment_id to check just one.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
      assignment_id: z.number().optional().describe("Check a single assignment instead of scanning the course"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id, assignment_id }) => {
    const me = await canvasGet("/users/self/profile");

    let targets: any[];
    if (assignment_id !== undefined) {
      targets = [await canvasGet(`/courses/${course_id}/assignments/${assignment_id}`)];
    } else {
      const { items } = await canvasGetPaginated(`/courses/${course_id}/assignments`);
      targets = items.filter((a: any) => a.peer_reviews);
    }

    if (!targets.length) {
      return textResult("No peer-review assignments in this course.");
    }

    const out: any[] = [];
    for (const a of targets) {
      let reviews: any[] = [];
      try {
        ({ items: reviews } = await canvasGetPaginated(
          `/courses/${course_id}/assignments/${a.id}/peer_reviews`,
          { "include[]": ["user"] },
          1
        ));
      } catch {
        continue;
      }
      for (const r of reviews) {
        if (r.assessor_id !== me.id) continue; // only reviews *I* owe
        out.push({
          assignment: a.name,
          assignment_id: a.id,
          due_at: a.peer_reviews_due_at ?? a.due_at,
          reviewing: r.user?.display_name ?? `user ${r.user_id}`,
          state: r.workflow_state,
          url: `${baseUrl()}/courses/${course_id}/assignments/${a.id}/submissions/${r.user_id}`,
        });
      }
    }

    if (!out.length) {
      return textResult(
        `Found ${targets.length} peer-review assignment(s), but none are currently assigned to you to review.`
      );
    }
    return jsonResult(out);
  })
);

// ---------------------------------------------------------------------------
// Workflow tool: full course export (Notion-ready markdown)
// ---------------------------------------------------------------------------

server.registerTool(
  "canvas_export_course",
  {
    title: "Export course to markdown",
    description:
      "One-shot export of a course as a single markdown document: details, syllabus, grade, all assignments with submission status, " +
      "module outline, and recent announcements. Designed for archiving to Notion or notes apps.",
    inputSchema: {
      course_id: z.number().describe("Canvas course ID"),
    },
    annotations: READ_ONLY,
  },
  safe(async ({ course_id }) => {
    const [course, assignments, modules, announcements] = await Promise.all([
      canvasGet(`/courses/${course_id}`, {
        "include[]": ["syllabus_body", "term", "total_scores", "teachers"],
      }),
      canvasGetPaginated(`/courses/${course_id}/assignments`, {
        "include[]": ["submission"],
        order_by: "due_at",
      }),
      canvasGetPaginated(`/courses/${course_id}/modules`, { "include[]": ["items"] }),
      canvasGetPaginated("/announcements", {
        "context_codes[]": [`course_${course_id}`],
        start_date: new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10),
      }).catch(() => ({ items: [] as any[], truncated: false })),
    ]);

    const fmtDate = (d: string | null | undefined) =>
      d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—";

    const lines: string[] = [];
    lines.push(`# ${course.name}`);
    lines.push("");
    lines.push(`- **Course code:** ${course.course_code ?? "—"}`);
    lines.push(`- **Term:** ${course.term?.name ?? "—"}`);
    lines.push(`- **Instructor(s):** ${(course.teachers ?? []).map((t: any) => t.display_name).join(", ") || "—"}`);
    const enr = course.enrollments?.[0];
    if (enr?.computed_current_score != null) {
      lines.push(`- **Current grade:** ${enr.computed_current_score}% (${enr.computed_current_grade ?? "—"})`);
    }
    lines.push("");

    const syllabus = htmlToText(course.syllabus_body, 30000);
    if (syllabus) {
      lines.push("## Syllabus");
      lines.push("");
      lines.push(syllabus);
      lines.push("");
    }

    lines.push("## Assignments");
    lines.push("");
    lines.push("| Assignment | Due | Points | Status | Score |");
    lines.push("|---|---|---|---|---|");
    for (const a of assignments.items) {
      const s = a.submission;
      const status = s?.missing
        ? "MISSING"
        : s?.late
          ? "late"
          : s?.workflow_state === "graded"
            ? "graded"
            : s?.submitted_at
              ? "submitted"
              : "not submitted";
      const score = s?.score != null ? `${s.score}/${a.points_possible ?? "?"}` : "—";
      lines.push(
        `| ${(a.name ?? "").replace(/\|/g, "/")} | ${fmtDate(a.due_at)} | ${a.points_possible ?? "—"} | ${status} | ${score} |`
      );
    }
    lines.push("");

    if (modules.items.length) {
      lines.push("## Modules");
      lines.push("");
      for (const m of modules.items) {
        lines.push(`### ${m.name}`);
        for (const i of m.items ?? []) {
          lines.push(`- [${i.type}] ${i.title}`);
        }
        lines.push("");
      }
    }

    if (announcements.items.length) {
      lines.push("## Recent announcements");
      lines.push("");
      for (const a of announcements.items) {
        lines.push(`### ${a.title} — ${fmtDate(a.posted_at)}`);
        lines.push("");
        lines.push(htmlToText(a.message, 2000));
        lines.push("");
      }
    }

    return textResult(lines.join("\n"));
  })
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `canvas-student-mcp running (stdio) → ${process.env.CANVAS_BASE_URL ?? "(CANVAS_BASE_URL not set — tools will explain how to configure it)"}`
);
