import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, when, clip, section, relativeDue } from './helpers.js';
import { courseLabel, fileDetailOf, isContainer, type BbContent } from '../client/index.js';
import { htmlToText, extractEmbeddedFiles } from '../lib/extract.js';
import { fmtBytes } from '../lib/files.js';
import { recogniseExternalDocument, linkTargetOf } from '../lib/external.js';
import { assignmentBriefOf } from '../lib/brief.js';

/** Short, scannable label for a content item's type. */
export function handlerLabel(handler: string | undefined): string {
  if (!handler) return 'item';
  if (handler.startsWith('resource/x-bb-bltiplacement-')) return 'tool';
  const map: Record<string, string> = {
    'resource/x-bb-folder': 'folder',
    'resource/x-bb-lesson': 'lesson',
    'resource/x-bb-file': 'file',
    'resource/x-bb-document': 'document',
    'resource/x-bb-assignment': 'assignment',
    'resource/x-bb-asmt-test-link': 'test',
    'resource/x-bb-externallink': 'link',
    'resource/x-bb-courselink': 'course-link',
    'resource/x-bb-forumlink': 'discussion',
    'resource/x-bb-toollink': 'tool',
  };
  return map[handler] ?? handler.replace('resource/x-bb-', '');
}

/** One row describing a content item, shared by the listing tools. */
function contentRow(c: BbContent, showPath: boolean): Record<string, string | number | undefined> {
  const file = fileDetailOf(c);
  const detail = c.contentHandler ? c.contentDetail?.[c.contentHandler] : undefined;
  return {
    contentId: c.id,
    type: handlerLabel(c.contentHandler),
    [showPath ? 'path' : 'title']: clip(showPath ? (c._path ?? c.title) : c.title, 90),
    file: file?.fileName ? `${clip(file.fileName, 40)} (${fmtBytes(file.fileSize ?? 0)})` : undefined,
    link: typeof detail?.url === 'string' ? clip(detail.url, 50) : undefined,
    hidden: c.visibility && c.visibility !== 'Visible' ? c.visibility : undefined,
    modified: when(c.modifiedDate),
  };
}

export function registerContentTools(server: McpServer): void {
  server.registerTool(
    'bb_browse_course',
    {
      title: 'Browse a course content tree',
      description:
        'Walks the full content outline of a course recursively and returns every item with its folder path, type, and any attached file. This is the primary way to discover what material a course contains. Use maxDepth/maxNodes to bound very large courses.',
      inputSchema: {
        courseId: z.string().describe('Course id from bb_list_courses, e.g. "_12345_1".'),
        rootId: z
          .string()
          .optional()
          .describe('Start from this folder/lesson instead of the course root.'),
        maxDepth: z.number().int().min(1).max(10).optional().describe('Default 6.'),
        maxNodes: z.number().int().min(1).max(2000).optional().describe('Default 600.'),
        type: z
          .string()
          .optional()
          .describe('Filter to one type: folder, lesson, file, document, assignment, test, link, discussion, tool.'),
        filesOnly: z.boolean().optional().describe('Only items with a downloadable file attached.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_browse_course', async (args) => {
      const client = await getClient();
      const [name, nodes] = await Promise.all([
        client.courseName(args.courseId),
        client.walkContents(args.courseId, {
          maxDepth: args.maxDepth,
          maxNodes: args.maxNodes,
          rootId: args.rootId,
        }),
      ]);

      let rows = nodes;
      if (args.type) {
        const want = args.type.toLowerCase();
        rows = rows.filter((c) => handlerLabel(c.contentHandler) === want);
      }
      if (args.filesOnly) rows = rows.filter((c) => fileDetailOf(c) !== null);

      const containers = rows.filter(isContainer).length;
      const files = rows.filter((c) => fileDetailOf(c) !== null).length;

      return text(
        [
          `# ${name}`,
          '',
          `${rows.length} item(s). ${containers} folder/lesson, ${files} with files.`,
          '',
          table(rows.map((c) => contentRow(c, true))),
          '',
          '_Use `bb_get_content` for an item\'s full text, `bb_read_file` to read an attached file._',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_list_content',
    {
      title: 'List content in a course folder',
      description:
        'Lists the immediate children of a course folder or lesson, or the top level of the course when no folder is given. Prefer bb_browse_course unless you specifically want one level.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        contentId: z
          .string()
          .optional()
          .describe('Folder/lesson id. Omit for the course top level.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_content', async ({ courseId, contentId, limit }) => {
      const client = await getClient();
      const rows = contentId
        ? await client.listChildren(courseId, contentId, { limit: limit ?? 200 })
        : await client.listTopLevelContents(courseId, { limit: limit ?? 200 });
      return text(`${rows.length} item(s).\n\n${table(rows.map((c) => contentRow(c, false)))}`);
    }),
  );

  server.registerTool(
    'bb_get_content',
    {
      title: 'Read a course content item',
      description:
        'Full detail for one content item: its rendered body text, attached file metadata, external link target, due date, and any files embedded in the body HTML. Use this to actually read an announcement-style document or assignment brief.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        contentId: z.string().describe('Content item id, e.g. "_10001_1".'),
        includeChildren: z
          .boolean()
          .optional()
          .describe('If the item is a folder/lesson, also list its children. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_get_content', async ({ courseId, contentId, includeChildren }) => {
      const client = await getClient();
      const item = await client.getContent(courseId, contentId);
      const handler = item.contentHandler;
      const detail = handler ? item.contentDetail?.[handler] : undefined;
      const file = fileDetailOf(item);

      const head = table([
        { field: 'title', value: item.title },
        { field: 'type', value: `${handlerLabel(handler)} (${handler ?? 'unknown'})` },
        { field: 'contentId', value: item.id },
        { field: 'parentId', value: item.parentId },
        { field: 'visibility', value: item.visibility },
        { field: 'modified', value: when(item.modifiedDate) },
        { field: 'reviewable', value: item.isReviewable ? 'yes' : undefined },
        { field: 'group content', value: item.isGroupContent ? 'yes' : undefined },
      ]);

      // Body: prefer the render-ready HTML, fall back to raw text.
      const bodyHtml = item.body?.displayText ?? item.body?.rawText ?? '';
      const body = bodyHtml ? htmlToText(bodyHtml) : '';

      let fileInfo = '';
      if (file) {
        fileInfo = table([
          { field: 'fileName', value: file.fileName },
          { field: 'mimeType', value: file.mimeType },
          { field: 'size', value: file.fileSize ? fmtBytes(file.fileSize) : undefined },
          { field: 'downloadable', value: 'yes. Use bb_read_file or bb_download_file' },
        ]);
      }

      let linkInfo = '';
      const linkUrl = linkTargetOf(handler, item.contentDetail);
      if (linkUrl) {
        const external = recogniseExternalDocument(linkUrl);
        linkInfo = external
          ? [
              linkUrl,
              '',
              `This is a linked ${external.kind} (${external.provider}). It holds no file in Blackboard, but **\`bb_read_file\` can read it directly**. Available formats: ${external.formats.join(', ')}.`,
            ].join('\n')
          : linkUrl;
      }

      // Assignments and tests carry their gradebook column, which is where the
      // due date and points actually live.
      let gradeInfo = '';
      const columnId = (detail?.gradeColumnId ?? detail?.gradebookColumnId) as string | undefined;
      if (columnId) {
        try {
          const col = await client.getGradeColumn(courseId, columnId);
          gradeInfo = table([
            { field: 'columnId', value: col.id },
            { field: 'points possible', value: col.possible },
            { field: 'due', value: when(col.dueDate) },
            { field: 'attempts allowed', value: col.multipleAttempts },
          ]);
        } catch {
          gradeInfo = `_Linked gradebook column ${columnId} could not be read._`;
        }
      }

      // Assignment and test details live several levels inside contentDetail and
      // are unreachable from `body`, which is empty on those items.
      const brief = assignmentBriefOf(item);
      let briefBody = '';
      if (brief) {
        briefBody = table([
          { field: 'due', value: brief.dueDate ? `${when(brief.dueDate)} (${relativeDue(brief.dueDate)}) UTC` : undefined },
          { field: 'points possible', value: brief.pointsPossible },
          { field: 'attempts allowed', value: brief.attemptsAllowed },
          { field: 'accepts text', value: brief.allowsText === undefined ? undefined : brief.allowsText ? 'yes' : 'no' },
          { field: 'accepts files', value: brief.allowsFiles === undefined ? undefined : brief.allowsFiles ? 'yes' : 'no' },
          { field: 'due date enforced', value: brief.dueDateEnforced ? 'yes' : undefined },
          { field: 'late attempts blocked', value: brief.lateAttemptsBlocked ? 'YES' : undefined },
          { field: 'timer', value: brief.timer },
          { field: 'password required', value: brief.requiresPassword ? 'yes' : undefined },
          { field: 'secure browser', value: brief.requiresSecureBrowser ? 'required' : undefined },
          { field: 'webcam', value: brief.requiresWebcam ? 'required' : undefined },
          { field: 'backtracking', value: brief.backtrackingProhibited ? 'not allowed' : undefined },
          { field: 'questions randomised', value: brief.questionsRandomised ? 'yes' : undefined },
          { field: 'reveals score', value: brief.showsScore === false ? 'no' : undefined },
          { field: 'reveals correct answers', value: brief.showsCorrectAnswers === false ? 'no' : undefined },
        ]);
        if (brief.instructionsText) {
          briefBody += `\n\n**Instructions**\n\n${clip(brief.instructionsText, 3000)}`;
        }
        if (brief.links.length > 0) {
          briefBody += `\n\n${table(brief.links.map((url) => ({ link: url })))}`;
        }
      }

      const embedded = bodyHtml ? extractEmbeddedFiles(bodyHtml) : [];
      const embeddedInfo = embedded.length
        ? table(embedded.map((e) => ({ embeddedPath: e.url })))
        : '';

      let children = '';
      if (includeChildren !== false && isContainer(item)) {
        try {
          const kids = await client.listChildren(courseId, contentId, { limit: 200 });
          children = table(kids.map((c) => contentRow(c, false)));
        } catch {
          children = '_Children could not be listed._';
        }
      }

      return text(
        [
          `# ${item.title ?? contentId}`,
          '',
          head,
          section('Body', body),
          section('Attached file', fileInfo),
          section('Link target', linkInfo),
          section('Assignment brief', briefBody),
          section('Gradebook', gradeInfo),
          section('Files embedded in body', embeddedInfo),
          section('Children', children),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_search_content',
    {
      title: 'Search course content',
      description:
        'Searches content item titles and body text for a query string, in one course or across every enrolled course. Use this when the user asks where something is ("where are the lecture slides on transformers?"). Searching all courses walks each tree, so prefer a single courseId when you know it.',
      inputSchema: {
        query: z.string().min(2).describe('Case-insensitive text to look for in titles and bodies.'),
        courseId: z
          .string()
          .optional()
          .describe('Restrict to one course. Omit to search all enrolled courses.'),
        titlesOnly: z.boolean().optional().describe('Match titles only, not body text. Faster.'),
        maxCourses: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Cap how many courses are searched when courseId is omitted. Default 10.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max matches. Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_search_content', async (args) => {
      const client = await getClient();
      const needle = args.query.toLowerCase();
      const limit = args.limit ?? 50;

      const courseIds: string[] = [];
      const labels = new Map<string, string>();
      if (args.courseId) {
        courseIds.push(args.courseId);
        labels.set(args.courseId, await client.courseName(args.courseId));
      } else {
        const memberships = await client.listCourses({ availableOnly: true });
        for (const m of memberships.slice(0, args.maxCourses ?? 10)) {
          const id = m.course?.id ?? m.courseId;
          courseIds.push(id);
          labels.set(id, courseLabel(m.course));
        }
      }

      const matches: Array<Record<string, string | number | undefined>> = [];
      const searched: string[] = [];

      for (const id of courseIds) {
        if (matches.length >= limit) break;
        let nodes: BbContent[];
        try {
          nodes = await client.walkContents(id, { maxNodes: 400 });
        } catch (err) {
          // One inaccessible course must not sink the whole search.
          searched.push(`${labels.get(id) ?? id} (failed: ${(err as Error).message})`);
          continue;
        }
        searched.push(labels.get(id) ?? id);

        for (const node of nodes) {
          if (matches.length >= limit) break;
          const title = (node.title ?? '').toLowerCase();
          const bodyHtml = node.body?.displayText ?? node.body?.rawText ?? '';
          const file = fileDetailOf(node);
          const fileName = (file?.fileName ?? '').toLowerCase();

          const inTitle = title.includes(needle) || fileName.includes(needle);
          const inBody = !args.titlesOnly && htmlToText(bodyHtml).toLowerCase().includes(needle);
          if (!inTitle && !inBody) continue;

          matches.push({
            course: clip(labels.get(id) ?? id, 30),
            courseId: id,
            contentId: node.id,
            type: handlerLabel(node.contentHandler),
            path: clip(node._path ?? node.title, 70),
            matchedIn: inTitle ? 'title' : 'body',
          });
        }
      }

      return text(
        [
          `${matches.length} match(es) for "${args.query}" across ${searched.length} course(s).`,
          '',
          table(matches),
          '',
          `_Searched: ${searched.join('; ')}_`,
        ].join('\n'),
      );
    }),
  );
}
