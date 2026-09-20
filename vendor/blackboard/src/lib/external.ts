import { BlackboardError } from './errors.js';
import { log } from './logger.js';
import { fmtBytes } from './files.js';

/**
 * Resolves external documents that course content merely *links* to.
 *
 * Instructors routinely publish material as a Google Slides/Docs link rather
 * than uploading a file, which leaves a `resource/x-bb-externallink` item that
 * dead-ends at a URL. Blackboard holds no bytes at all. Since these links are
 * often the majority of a course's real material, resolving them is the
 * difference between "read me the lecture" working and not.
 *
 * Two hard rules, because the URL comes out of Blackboard content and is
 * therefore untrusted input written by a third party:
 *
 *   1. **Provider allowlist.** Only known document hosts with a documented
 *      export endpoint are fetched. Without this, a pasted link would turn this
 *      tool into an arbitrary URL fetcher, which is a request-forgery primitive
 *      and a data-exfiltration path.
 *   2. **No credentials, ever.** These fetches carry no Blackboard cookies, no
 *      session, and no auth of any kind. Only material the instructor already
 *      made link-shareable is reachable, which is exactly the intended scope.
 */

export type ExternalKind = 'presentation' | 'document' | 'spreadsheet' | 'file';

export interface ExternalDocument {
  provider: 'google';
  kind: ExternalKind;
  id: string;
  /** Canonical view URL, for reporting back to the user. */
  viewUrl: string;
  /** Export formats this kind supports, best-for-reading first. */
  formats: string[];
  /** Builds the export URL for a format. */
  exportUrl(format: string): string;
}

/** Formats per document kind, ordered so the first is cheapest to read. */
const GOOGLE_FORMATS: Record<ExternalKind, string[]> = {
  presentation: ['txt', 'pdf', 'pptx'],
  document: ['txt', 'pdf', 'docx'],
  spreadsheet: ['csv', 'pdf', 'xlsx'],
  file: ['pdf'],
};

const GOOGLE_KINDS: Record<string, ExternalKind> = {
  presentation: 'presentation',
  document: 'document',
  spreadsheets: 'spreadsheet',
};

/**
 * Recognises a supported external document URL, or returns null.
 *
 * Deliberately strict: the host must be exactly a Google Docs host and the path
 * must match the documented `/{kind}/d/{id}` shape.
 */
export function recogniseExternalDocument(rawUrl: string): ExternalDocument | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'docs.google.com' && url.hostname !== 'drive.google.com') return null;

  // /presentation/d/<id>/edit  ·  /document/d/<id>  ·  /spreadsheets/d/<id>
  const docMatch = /^\/(presentation|document|spreadsheets)\/d\/([A-Za-z0-9_-]{10,})/.exec(
    url.pathname,
  );
  if (docMatch) {
    const kind = GOOGLE_KINDS[docMatch[1]!]!;
    const id = docMatch[2]!;
    return {
      provider: 'google',
      kind,
      id,
      viewUrl: `https://docs.google.com/${docMatch[1]}/d/${id}/edit`,
      formats: GOOGLE_FORMATS[kind],
      exportUrl: (format) => `https://docs.google.com/${docMatch[1]}/d/${id}/export/${format}`,
    };
  }

  // Drive-hosted files (a PDF uploaded to Drive rather than a native doc).
  const fileMatch = /^\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (fileMatch) {
    const id = fileMatch[1]!;
    return {
      provider: 'google',
      kind: 'file',
      id,
      viewUrl: `https://drive.google.com/file/d/${id}/view`,
      formats: ['pdf'],
      exportUrl: () => `https://drive.google.com/uc?export=download&id=${id}`,
    };
  }

  return null;
}

export interface ExternalFetchResult {
  data: Buffer;
  /** The format actually retrieved. */
  format: string;
  mimeType: string;
  bytes: number;
}

/**
 * Downloads an external document, without credentials.
 *
 * Google answers a request for something not link-shared with an HTML page
 * (404 or a sign-in wall) rather than an error status alone, so the content
 * type is checked as well. Otherwise a "successful" fetch would hand back a
 * login page dressed up as a slide deck.
 */
export async function fetchExternalDocument(
  doc: ExternalDocument,
  opts: { format?: string; maxBytes: number } = { maxBytes: 50 * 1024 * 1024 },
): Promise<ExternalFetchResult> {
  const format = opts.format ?? doc.formats[0]!;
  if (!doc.formats.includes(format)) {
    throw new BlackboardError('BAD_INPUT', `Format "${format}" is not available for a ${doc.kind}.`, {
      hint: `Supported: ${doc.formats.join(', ')}`,
    });
  }

  const url = doc.exportUrl(format);
  log.debug(`Fetching external document (no credentials): ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      // Explicitly no cookies and no auth: this is a third-party host.
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: '*/*', 'User-Agent': 'blackboard-mcp' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    throw new BlackboardError('NETWORK', `Could not reach ${new URL(url).hostname}.`, { cause });
  }

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();

  if (!res.ok) {
    throw new BlackboardError('FORBIDDEN', `The linked document is not publicly accessible (HTTP ${res.status}).`, {
      status: res.status,
      hint: `It is shared privately, so it can only be opened while signed in to Google: ${doc.viewUrl}`,
    });
  }

  // A text/html body where a document was expected is a sign-in wall.
  const expectingHtml = format === 'html';
  if (!expectingHtml && contentType.includes('text/html')) {
    throw new BlackboardError('FORBIDDEN', 'The linked document requires a Google sign-in.', {
      hint: `Google returned a web page instead of the file, which means it is not link-shared. Open it in a browser: ${doc.viewUrl}`,
    });
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > opts.maxBytes) {
    throw new BlackboardError('BAD_INPUT', `Linked document is ${fmtBytes(declared)}, above the ${fmtBytes(opts.maxBytes)} limit.`, {
      hint: `Try a lighter format: ${doc.formats.join(', ')}`,
    });
  }

  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > opts.maxBytes) {
    throw new BlackboardError('BAD_INPUT', `Linked document is ${fmtBytes(data.byteLength)}, above the limit.`);
  }

  return { data, format, mimeType: contentType || 'application/octet-stream', bytes: data.byteLength };
}

/** A filename for a fetched external document. */
export function externalFileName(title: string | undefined, doc: ExternalDocument, format: string): string {
  const stem = (title ?? `${doc.kind}-${doc.id.slice(0, 12)}`).trim();
  return `${stem}.${format}`;
}

/**
 * Pulls a link target out of a content item's `contentDetail`.
 *
 * External links, LTI placements and course links all stash their target
 * differently, so this normalises the handful of shapes actually observed.
 */
export function linkTargetOf(
  contentHandler: string | undefined,
  contentDetail: Record<string, Record<string, unknown>> | undefined,
): string | undefined {
  if (!contentHandler || !contentDetail) return undefined;
  const detail = contentDetail[contentHandler];
  if (!detail) return undefined;
  for (const key of ['url', 'href', 'launchUrl']) {
    const value = detail[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
