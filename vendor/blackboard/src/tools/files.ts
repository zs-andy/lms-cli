import { z } from 'zod';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, clip, section } from './helpers.js';
import {
  courseLabel, fileDetailOf, type BlackboardClient, type BbContent,
} from '../client/index.js';
import { BlackboardError } from '../lib/errors.js';
import { downloadToDisk, rawFileUrl, courseSubdir, fmtBytes, safeFileName } from '../lib/files.js';
import { extractText, extractEmbeddedFiles } from '../lib/extract.js';
import { handlerLabel } from './content.js';
import {
  recogniseExternalDocument, fetchExternalDocument, linkTargetOf, externalFileName,
  type ExternalDocument,
} from '../lib/external.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../lib/paths.js';

/** A downloadable thing discovered on a content item. */
interface FileTarget {
  url: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  /** Where the reference was found. */
  source: 'contentDetail' | 'attachment' | 'embedded';
}

/**
 * Finds every downloadable file reachable from one content item.
 *
 * Blackboard exposes files three different ways and instructors use all of
 * them interchangeably, so checking only one route misses material:
 *   1. `contentDetail` on a `resource/x-bb-file` item. The common case
 *   2. the `attachments` sub-resource, used by Ultra Documents and assignments
 *   3. `/bbcswebdav/` links embedded in the body HTML. Used when an
 *      instructor pastes a handout into a page instead of attaching it
 */
async function resolveFileTargets(
  client: BlackboardClient,
  courseId: string,
  contentId: string,
): Promise<{ item: BbContent; targets: FileTarget[] }> {
  const item = await client.getContent(courseId, contentId);
  const targets: FileTarget[] = [];

  const detail = fileDetailOf(item);
  if (detail?.permanentUrl || detail?.viewerUrl) {
    targets.push({
      url: rawFileUrl(detail),
      fileName: safeFileName(detail.fileName, 'file'),
      mimeType: detail.mimeType,
      size: detail.fileSize,
      source: 'contentDetail',
    });
  }

  try {
    for (const att of await client.listAttachments(courseId, contentId)) {
      targets.push({
        url: client.attachmentDownloadPath(courseId, contentId, att.id),
        fileName: safeFileName(att.fileName, att.id),
        mimeType: att.mimeType,
        size: att.size,
        source: 'attachment',
      });
    }
  } catch {
    // Tenants without the attachments sub-resource return 404/403; not fatal.
  }

  const bodyHtml = item.body?.displayText ?? item.body?.rawText ?? '';
  for (const emb of extractEmbeddedFiles(bodyHtml)) {
    if (targets.some((t) => t.url.split('?')[0] === emb.url.split('?')[0])) continue;
    targets.push({
      url: `${emb.url}${emb.url.includes('?') ? '&' : '?'}xythos-download=true`,
      fileName: safeFileName(decodeURIComponent(basename(emb.url.split('?')[0]!)), 'embedded'),
      source: 'embedded',
    });
  }

  return { item, targets };
}

/**
 * Downloads an externally-linked document (e.g. Google Slides) to disk.
 *
 * Kept separate from the Blackboard download path on purpose: this fetch must
 * carry no session cookies, so it cannot reuse the authenticated HTTP client.
 */
async function fetchLinkedDocument(
  doc: ExternalDocument,
  opts: { dir: string; title?: string; format?: string; maxBytes: number },
): Promise<{ path: string; fileName: string; bytes: number; mimeType: string; format: string }> {
  const fetched = await fetchExternalDocument(doc, {
    format: opts.format,
    maxBytes: opts.maxBytes,
  });
  const fileName = safeFileName(externalFileName(opts.title, doc, fetched.format));
  ensureDir(opts.dir);
  const path = join(opts.dir, fileName);
  writeFileSync(path, fetched.data, { mode: 0o600 });
  return {
    path,
    fileName,
    bytes: fetched.bytes,
    mimeType: fetched.mimeType,
    format: fetched.format,
  };
}

function pickTarget(targets: FileTarget[], wanted: string | undefined): FileTarget {
  if (targets.length === 0) {
    throw new BlackboardError('NOT_FOUND', 'This content item has no downloadable file.', {
      hint: 'Use bb_get_content to inspect the item. It may be a link, a folder, or an LTI tool rather than a file.',
    });
  }
  if (!wanted) return targets[0]!;
  const needle = wanted.toLowerCase();
  const hit = targets.find((t) => t.fileName.toLowerCase().includes(needle));
  if (!hit) {
    throw new BlackboardError('NOT_FOUND', `No file matching "${wanted}" on this item.`, {
      hint: `Available: ${targets.map((t) => t.fileName).join(', ')}`,
    });
  }
  return hit;
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    'bb_list_files',
    {
      title: 'List downloadable files in a course',
      description:
        'Walks a course and lists every readable document: attached files, attachments, files embedded in page bodies, and content items that link to Google Slides, Docs or Sheets. Returns name, type, size and the contentId needed to fetch each one.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        extension: z
          .string()
          .optional()
          .describe('Filter by extension, e.g. "pdf" or ".pptx".'),
        maxNodes: z.number().int().min(1).max(2000).optional().describe('Tree walk cap. Default 600.'),
        deep: z
          .boolean()
          .optional()
          .describe('Also probe every item for attachments and embedded files. Slower but complete. Default false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_list_files', async (args) => {
      const client = await getClient();
      const [name, nodes] = await Promise.all([
        client.courseName(args.courseId),
        client.walkContents(args.courseId, { maxNodes: args.maxNodes ?? 600 }),
      ]);

      const rows: Array<Record<string, string | number | undefined>> = [];
      const wantExt = args.extension?.replace(/^\./, '').toLowerCase();

      const push = (node: BbContent, fileName: string, size?: number, mime?: string, source?: string) => {
        if (wantExt && !fileName.toLowerCase().endsWith(`.${wantExt}`)) return;
        rows.push({
          contentId: node.id,
          fileName: clip(fileName, 55),
          size: size ? fmtBytes(size) : undefined,
          type: mime,
          source,
          path: clip(node._path, 60),
        });
      };

      for (const node of nodes) {
        const detail = fileDetailOf(node);
        if (detail?.fileName) {
          push(node, detail.fileName, detail.fileSize, detail.mimeType, 'file');
        }

        // Linked Google documents hold no bytes in Blackboard but are readable
        // all the same, so they belong in a list of a course's material.
        const linkUrl = linkTargetOf(node.contentHandler, node.contentDetail);
        const external = linkUrl ? recogniseExternalDocument(linkUrl) : null;
        if (external) {
          push(
            node,
            `${node.title ?? external.id}.${external.formats[0]}`,
            undefined,
            `linked ${external.kind}`,
            'link',
          );
        }

        const bodyHtml = node.body?.displayText ?? node.body?.rawText ?? '';
        for (const emb of extractEmbeddedFiles(bodyHtml)) {
          push(node, decodeURIComponent(basename(emb.url.split('?')[0]!)), undefined, undefined, 'embedded');
        }

        // The attachments probe is one request per item, so it is opt-in.
        if (args.deep && !detail) {
          try {
            for (const att of await client.listAttachments(args.courseId, node.id)) {
              push(node, att.fileName ?? att.id, att.size, att.mimeType, 'attachment');
            }
          } catch {
            /* no attachments sub-resource on this item */
          }
        }
      }

      return text(
        [
          `# Files in ${name}`,
          '',
          `${rows.length} file(s) across ${nodes.length} content item(s).`,
          args.deep ? '' : '_Attachments were not probed; pass deep=true for an exhaustive list._',
          '',
          table(rows),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_read_file',
    {
      title: 'Read a course file as text',
      description:
        'Downloads a file attached to a content item and extracts its text. Also resolves content items that merely LINK to a Google Slides/Docs/Sheets document (common for lecture decks) by fetching the provider export, so reading works the same either way. PDFs are returned a page-window at a time (use fromPage to continue), so a long document will not flood the context. Handles PDF, HTML, and plain-text/code/CSV; Office formats download but cannot be extracted. This is the tool to use to actually read lecture notes or a handout.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        contentId: z.string().describe('Content item id holding the file.'),
        fileName: z
          .string()
          .optional()
          .describe('When the item has several files, pick by name substring.'),
        fromPage: z.number().int().min(1).optional().describe('First PDF page. Default 1.'),
        maxPages: z.number().int().min(1).max(80).optional().describe('PDF pages per call. Default 15.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .optional()
          .describe('Character ceiling for the returned window. Default 20000.'),
        charOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('For non-paginated formats, continue from this character offset.'),
        format: z
          .string()
          .optional()
          .describe('For externally-linked documents (Google Slides/Docs/Sheets), the export format: txt (default, cheapest), pdf, pptx, docx, csv, xlsx.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_read_file', async (args) => {
      const client = await getClient();
      const { item, targets } = await resolveFileTargets(client, args.courseId, args.contentId);
      const label = await client.courseName(args.courseId);

      // Many courses publish material as a Google Slides/Docs *link* rather
      // than an uploaded file, leaving no bytes in Blackboard at all. Resolve
      // those through the provider's export endpoint so reading works the same.
      const linkUrl = linkTargetOf(item.contentHandler, item.contentDetail);
      const external = linkUrl ? recogniseExternalDocument(linkUrl) : null;

      if (external && targets.length === 0) {
        const dl = await fetchLinkedDocument(external, {
          dir: courseSubdir(client.config.downloadDir!, label),
          title: item.title,
          format: args.format,
          maxBytes: client.config.maxDownloadBytes,
        });
        const extracted = await extractText(dl.path, {
          fromPage: args.fromPage,
          maxPages: args.maxPages,
          maxChars: args.maxChars,
          charOffset: args.charOffset,
          mimeType: dl.mimeType,
        });
        return text(
          [
            `# ${item.title ?? dl.fileName}`,
            '',
            table([
              { field: 'source', value: `linked ${external.kind} (${external.provider})` },
              { field: 'link', value: external.viewUrl },
              { field: 'fetched as', value: dl.format },
              { field: 'size', value: fmtBytes(dl.bytes) },
              { field: 'saved to', value: dl.path },
              { field: 'other formats', value: external.formats.filter((f) => f !== dl.format).join(', ') },
              {
                field: 'pages',
                value: extracted.totalPages
                  ? `${extracted.pageRange?.join('-') ?? '?'} of ${extracted.totalPages}`
                  : undefined,
              },
            ]),
            extracted.note ? `\n> ${extracted.note}\n` : '',
            '',
            '_This material lives outside Blackboard; it was fetched from the link with no credentials, so only link-shared documents are reachable._',
            extracted.text ? `\n---\n\n${extracted.text}` : '',
          ].join('\n'),
        );
      }

      const target = pickTarget(targets, args.fileName);

      const dl = await downloadToDisk(client.http, target.url, {
        dir: courseSubdir(client.config.downloadDir!, label),
        fileName: target.fileName,
        maxBytes: client.config.maxDownloadBytes,
        expectedBytes: target.size,
      });

      const extracted = await extractText(dl.path, {
        fromPage: args.fromPage,
        maxPages: args.maxPages,
        maxChars: args.maxChars,
        charOffset: args.charOffset,
        mimeType: dl.mimeType,
      });

      const meta = table([
        { field: 'file', value: dl.fileName },
        { field: 'from', value: `${item.title ?? args.contentId} (${handlerLabel(item.contentHandler)})` },
        { field: 'size', value: fmtBytes(dl.bytes) },
        { field: 'type', value: dl.mimeType },
        { field: 'saved to', value: dl.path },
        { field: 'format', value: extracted.format },
        {
          field: 'pages',
          value: extracted.totalPages
            ? `${extracted.pageRange?.join('-') ?? '?'} of ${extracted.totalPages}`
            : undefined,
        },
        { field: 'characters', value: extracted.totalChars || undefined },
      ]);

      const notes = extracted.note ? `\n> ${extracted.note}\n` : '';
      const others =
        targets.length > 1
          ? `\n_Other files on this item: ${targets
              .filter((t) => t !== target)
              .map((t) => t.fileName)
              .join(', ')}_\n`
          : '';

      return text(
        [
          `# ${dl.fileName}`,
          '',
          meta,
          notes,
          others,
          extracted.text ? `\n---\n\n${extracted.text}` : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_download_file',
    {
      title: 'Download a course file to disk',
      description:
        'Downloads a file from a content item and saves it locally without extracting text. Use this for Office documents, images, archives, or anything the user wants to keep. Also handles content items that link to Google Slides/Docs/Sheets, fetching the export (pptx/docx/xlsx/pdf). Returns the saved path.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        contentId: z.string().describe('Content item id holding the file.'),
        fileName: z.string().optional().describe('Pick by name substring when several files exist.'),
        all: z.boolean().optional().describe('Download every file on the item, not just the first.'),
        format: z
          .string()
          .optional()
          .describe('For externally-linked Google documents: pdf (default for download), pptx, docx, xlsx, csv, txt.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_download_file', async (args) => {
      const client = await getClient();
      const { item, targets } = await resolveFileTargets(client, args.courseId, args.contentId);
      const label = await client.courseName(args.courseId);
      const dir = courseSubdir(client.config.downloadDir!, label);

      const linkUrl = linkTargetOf(item.contentHandler, item.contentDetail);
      const external = linkUrl ? recogniseExternalDocument(linkUrl) : null;
      if (external && targets.length === 0) {
        const dl = await fetchLinkedDocument(external, {
          dir,
          title: item.title,
          format: args.format,
          maxBytes: client.config.maxDownloadBytes,
        });
        return text(
          [
            `Fetched a linked ${external.kind} from ${external.provider}.`,
            '',
            table([
              { file: dl.fileName, size: fmtBytes(dl.bytes), format: dl.format, path: dl.path },
            ]),
            '',
            `Source: ${external.viewUrl}`,
            `Other formats available: ${external.formats.filter((f) => f !== dl.format).join(', ')}`,
          ].join('\n'),
        );
      }

      const chosen = args.all ? targets : [pickTarget(targets, args.fileName)];
      const rows: Array<Record<string, string | number | undefined>> = [];

      for (const t of chosen) {
        try {
          const dl = await downloadToDisk(client.http, t.url, {
            dir,
            fileName: t.fileName,
            maxBytes: client.config.maxDownloadBytes,
            expectedBytes: t.size,
          });
          rows.push({
            file: dl.fileName,
            size: fmtBytes(dl.bytes),
            type: dl.mimeType,
            status: dl.cached ? 'already present' : 'downloaded',
            path: dl.path,
          });
        } catch (err) {
          rows.push({ file: t.fileName, status: `failed: ${(err as Error).message}` });
        }
      }

      return text(`${rows.length} file(s).\n\n${table(rows)}`);
    }),
  );

  server.registerTool(
    'bb_download_course_files',
    {
      title: 'Bulk download a course\'s files',
      description:
        'Walks a course and downloads every attached file to a local folder, organised by course. Use for archiving a course or grabbing all slides at once. Respects the configured size limit per file and skips files already on disk.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        extension: z.string().optional().describe('Only this extension, e.g. "pdf".'),
        maxFiles: z.number().int().min(1).max(300).optional().describe('Cap on downloads. Default 50.'),
        maxNodes: z.number().int().min(1).max(2000).optional().describe('Tree walk cap. Default 600.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_download_course_files', async (args) => {
      const client = await getClient();
      const label = await client.courseName(args.courseId);
      const dir = courseSubdir(client.config.downloadDir!, label);
      const nodes = await client.walkContents(args.courseId, { maxNodes: args.maxNodes ?? 600 });

      const wantExt = args.extension?.replace(/^\./, '').toLowerCase();
      const maxFiles = args.maxFiles ?? 50;

      const rows: Array<Record<string, string | number | undefined>> = [];
      let totalBytes = 0;
      let skipped = 0;

      for (const node of nodes) {
        if (rows.length >= maxFiles) break;
        const detail = fileDetailOf(node);
        if (!detail?.fileName) continue;
        if (wantExt && !detail.fileName.toLowerCase().endsWith(`.${wantExt}`)) continue;

        try {
          const dl = await downloadToDisk(client.http, rawFileUrl(detail), {
            dir,
            fileName: detail.fileName,
            maxBytes: client.config.maxDownloadBytes,
            expectedBytes: detail.fileSize,
          });
          if (dl.cached) skipped += 1;
          else totalBytes += dl.bytes;
          rows.push({
            file: clip(dl.fileName, 50),
            size: fmtBytes(dl.bytes),
            status: dl.cached ? 'cached' : 'ok',
            path: clip(node._path, 45),
          });
        } catch (err) {
          rows.push({
            file: clip(detail.fileName, 50),
            status: `failed: ${clip((err as Error).message, 70)}`,
          });
        }
      }

      return text(
        [
          `# Downloaded files: ${label}`,
          '',
          `${rows.length} file(s) processed, ${fmtBytes(totalBytes)} newly fetched, ${skipped} already present.`,
          `Saved under: \`${dir}\``,
          '',
          table(rows),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_download_submission',
    {
      title: 'Download a submitted assignment file',
      description:
        'Downloads the files the student submitted with an assignment attempt. Use bb_get_grade_detail first to find the attemptId and columnId.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        columnId: z.string().describe('Gradebook column id.'),
        attemptId: z.string().describe('Attempt id.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_download_submission', async ({ courseId, columnId, attemptId }) => {
      const client = await getClient();
      const label = await client.courseName(courseId);
      const dir = courseSubdir(client.config.downloadDir!, `${label} submissions`);
      const files = await client.listAttemptFiles(courseId, columnId, attemptId);

      if (files.length === 0) {
        return text(
          'No files are attached to this attempt.\n\nThe submission may be text-only. Check `studentSubmission` in `bb_get_grade_detail`.',
        );
      }

      const rows: Array<Record<string, string | number | undefined>> = [];
      for (const f of files) {
        const url = f.id
          ? client.attemptFileDownloadPath(courseId, columnId, attemptId, f.id)
          : f.permanentUrl;
        if (!url) {
          rows.push({ file: f.fileName, status: 'no download URL' });
          continue;
        }
        try {
          const dl = await downloadToDisk(client.http, url, {
            dir,
            fileName: f.fileName,
            maxBytes: client.config.maxDownloadBytes,
            expectedBytes: f.fileSize,
          });
          rows.push({ file: dl.fileName, size: fmtBytes(dl.bytes), path: dl.path, status: 'ok' });
        } catch (err) {
          rows.push({ file: f.fileName, status: `failed: ${(err as Error).message}` });
        }
      }

      return text(table(rows));
    }),
  );
}
