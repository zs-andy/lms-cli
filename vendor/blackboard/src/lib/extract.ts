import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { BlackboardError } from './errors.js';
import { log } from './logger.js';

/**
 * Text extraction for downloaded course material.
 *
 * The governing constraint is context, not correctness: a 300-page lecture PDF
 * is perfectly extractable and completely useless if it arrives as one blob.
 * So every extractor returns a *window* over the document plus the metadata a
 * caller needs to ask for the next one.
 */

export interface ExtractResult {
  /** The extracted window. */
  text: string;
  /** How the file was parsed. */
  format: 'pdf' | 'html' | 'text' | 'unsupported';
  /** Total pages, for paginated formats. */
  totalPages?: number;
  /** Inclusive 1-based page range this window covers. */
  pageRange?: [number, number];
  /** Total characters in the whole document, before windowing. */
  totalChars: number;
  /** True when the document continues past this window. */
  truncated: boolean;
  /** Human-readable note about what the caller should do next. */
  note?: string;
}

export interface ExtractOptions {
  /** 1-based first page (PDF only). */
  fromPage?: number;
  /** Max pages to pull in one call (PDF only). */
  maxPages?: number;
  /** Hard character ceiling for the returned window. */
  maxChars?: number;
  /** Byte offset for non-paginated formats, for windowing long text. */
  charOffset?: number;
  /** MIME type, when the caller knows it more reliably than the extension. */
  mimeType?: string;
}

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_PAGES = 15;

/** Extensions we can turn into text, keyed by how. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.log', '.rtf', '.tex', '.bib', '.srt', '.vtt', '.ics',
  '.py', '.js', '.ts', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs',
  '.rb', '.php', '.swift', '.kt', '.r', '.m', '.sql', '.sh',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

/**
 * Formats we can fetch but not read.
 *
 * Office formats are ZIP containers; parsing them needs a real unzip
 * implementation, which Node does not ship and which is not worth a native
 * dependency here. The file still downloads fine. Only extraction is refused,
 * with a message that says so.
 */
const KNOWN_BINARY: Record<string, string> = {
  '.docx': 'Word document',
  '.doc': 'legacy Word document',
  '.pptx': 'PowerPoint deck',
  '.ppt': 'legacy PowerPoint deck',
  '.xlsx': 'Excel workbook',
  '.xls': 'legacy Excel workbook',
  '.zip': 'ZIP archive',
  '.rar': 'RAR archive',
  '.7z': '7-Zip archive',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.avi': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ipynb': 'Jupyter notebook',
};

export async function extractText(
  filePath: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const ext = extname(filePath).toLowerCase();
  const mime = opts.mimeType ?? '';

  if (ext === '.pdf' || mime === 'application/pdf') {
    return extractPdf(filePath, { ...opts, maxChars });
  }
  if (HTML_EXTENSIONS.has(ext) || mime.includes('html')) {
    const html = readFileSync(filePath, 'utf8');
    return windowText(htmlToText(html), 'html', maxChars, opts.charOffset ?? 0);
  }
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime.includes('json')) {
    return windowText(readFileSync(filePath, 'utf8'), 'text', maxChars, opts.charOffset ?? 0);
  }

  const label = KNOWN_BINARY[ext];
  return {
    text: '',
    format: 'unsupported',
    totalChars: 0,
    truncated: false,
    note: label
      ? `Cannot extract text from a ${label} (${ext}). The file is downloaded and available at the path above; open it locally.`
      : `Unrecognised file type "${ext || mime || 'unknown'}". The file is downloaded and available at the path above.`,
  };
}

/**
 * PDF extraction, page-windowed.
 *
 * unpdf bundles a serverless build of pdf.js, so this needs no native module
 * and no system dependency.
 */
async function extractPdf(filePath: string, opts: ExtractOptions & { maxChars: number }): Promise<ExtractResult> {
  const { extractText: unpdfExtract, getDocumentProxy } = await import('unpdf');
  const bytes = new Uint8Array(readFileSync(filePath));

  let pages: string[];
  let totalPages: number;
  try {
    const pdf = await getDocumentProxy(bytes);
    const result = await unpdfExtract(pdf, { mergePages: false });
    pages = (result.text as unknown as string[]) ?? [];
    totalPages = result.totalPages ?? pages.length;
  } catch (cause) {
    throw new BlackboardError('UNSUPPORTED', 'Could not parse this PDF.', {
      hint: 'It may be encrypted, malformed, or a scanned image with no text layer. Scanned PDFs need OCR, which this server does not perform.',
      cause,
    });
  }

  const totalChars = pages.reduce((n, p) => n + p.length, 0);

  // A PDF with no text layer is almost always a scan. Say so, rather than
  // returning an empty string that looks like a bug.
  if (totalChars === 0) {
    return {
      text: '',
      format: 'pdf',
      totalPages,
      totalChars: 0,
      truncated: false,
      note: `This PDF has ${totalPages} page(s) but no extractable text layer, which means it is almost certainly a scan or an image export. Reading it requires OCR. If your institution has Blackboard Ally enabled, the course may offer an accessible/OCR'd alternative format.`,
    };
  }

  const from = Math.max(1, opts.fromPage ?? 1);
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const chunks: string[] = [];
  let used = 0;
  let last = from - 1;
  for (let p = from; p <= Math.min(totalPages, from + maxPages - 1); p += 1) {
    const body = (pages[p - 1] ?? '').trim();
    const block = `\n--- page ${p} ---\n${body}`;
    if (used + block.length > opts.maxChars && chunks.length > 0) break;
    chunks.push(block);
    used += block.length;
    last = p;
  }

  const truncated = last < totalPages;
  return {
    text: chunks.join('\n').trim(),
    format: 'pdf',
    totalPages,
    pageRange: [from, Math.max(from, last)],
    totalChars,
    truncated,
    note: truncated
      ? `Showing pages ${from}-${last} of ${totalPages}. Call again with fromPage=${last + 1} for the next window.`
      : undefined,
  };
}

/** Applies a character window to a flat string. */
function windowText(
  full: string,
  format: 'html' | 'text',
  maxChars: number,
  offset: number,
): ExtractResult {
  const slice = full.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  const truncated = end < full.length;
  return {
    text: slice,
    format,
    totalChars: full.length,
    truncated,
    note: truncated
      ? `Showing characters ${offset}-${end} of ${full.length}. Call again with charOffset=${end} for the next window.`
      : undefined,
  };
}

/**
 * Converts Blackboard's `displayText` HTML into readable plain text.
 *
 * Deliberately regex-based rather than a DOM parser: the input is small
 * announcement/description fragments, and pulling in a parser for this would
 * add weight without improving the result. Structure that carries meaning
 * (paragraphs, list items, links, headings) is preserved as text.
 */
export function htmlToText(html: string): string {
  let out = html;

  // Drop content that never renders as prose.
  out = out.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // Keep link targets, which often are the actual point of a Blackboard item.
  out = out.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      if (!text) return ` ${href} `;
      if (text === href) return ` ${href} `;
      return ` ${text} (${href}) `;
    },
  );

  // Preserve embedded file references, which the file tools can then resolve.
  out = out.replace(
    /<(?:iframe|img|source|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (_m, src: string) => ` [embedded: ${src}] `,
  );

  // Turn block structure into line breaks.
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n');
  out = out.replace(/<li\b[^>]*>/gi, '\n  - ');
  out = out.replace(/<\/(td|th)>/gi, '\t');
  out = out.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');

  // Everything else goes.
  out = out.replace(/<[^>]+>/g, '');

  out = decodeEntities(out);

  // Collapse the whitespace the tag removal leaves behind.
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-',
  mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  bull: '*', middot: '*', copy: '(c)', reg: '(R)', trade: '(TM)', deg: 'deg',
  eacute: 'e', egrave: 'e', agrave: 'a', ccedil: 'c', ntilde: 'n', uuml: 'u',
  ouml: 'o', auml: 'a', szlig: 'ss', euro: 'EUR', pound: 'GBP', aacute: 'a',
  iacute: 'i', oacute: 'o', uacute: 'u', Aacute: 'A', Eacute: 'E',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+\d?);/gi, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    log.debug(`Unrepresentable code point ${code}`);
    return '';
  }
}

/**
 * Pulls Blackboard file references out of an HTML body.
 *
 * Instructors routinely embed handouts inline rather than attaching them, so
 * these links are frequently the only route to the actual material. Only
 * same-instance `/bbcswebdav/` paths are returned; anything else could point
 * anywhere and must not be fetched with session cookies attached.
 */
export function extractEmbeddedFiles(html: string): Array<{ url: string; label?: string }> {
  const out: Array<{ url: string; label?: string }> = [];
  const seen = new Set<string>();
  const pattern = /(?:href|src)\s*=\s*["']([^"']*\/bbcswebdav\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    // Reject absolute URLs: only instance-relative paths are trustworthy here.
    if (/^https?:\/\//i.test(raw)) continue;
    const url = raw.startsWith('/') ? raw : `/${raw}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url });
  }
  return out;
}
