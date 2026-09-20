import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { ensureDir } from './paths.js';
import { BlackboardError } from './errors.js';
import { log } from './logger.js';
import type { HttpClient } from '../client/http.js';
import type { BbFileDetail } from '../client/types.js';

export interface DownloadResult {
  /** Absolute path the bytes were written to. */
  path: string;
  fileName: string;
  bytes: number;
  mimeType: string;
  sha256: string;
  /** True when an identical file was already on disk and the fetch was skipped. */
  cached: boolean;
  /** The final URL after following Blackboard's redirect chain. */
  resolvedFrom: string;
}

/** Control chars plus the characters that are unsafe on any of the three platforms. */
const UNSAFE = /[\u0000-\u001f<>:"/\\|?*]/g;

/**
 * Makes an untrusted, server-supplied filename safe to write.
 *
 * Blackboard filenames come from instructors and can contain path separators,
 * control bytes, leading dots, and Windows reserved device names.
 */
export function safeFileName(input: string | undefined, fallback = 'download'): string {
  let name = (input ?? '').replace(UNSAFE, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, ''); // no hidden files, no traversal
  name = name.replace(/[. ]+$/, ''); // Windows strips these anyway
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
  if (!name) name = fallback;
  // Leave headroom for the " (12)" dedupe suffix within the 255-byte limit.
  if (Buffer.byteLength(name) > 200) {
    const ext = extname(name).slice(0, 12);
    name = `${basename(name, extname(name)).slice(0, 150)}${ext}`;
  }
  return name;
}

/** Picks a non-colliding path, appending " (1)", " (2)", ... as needed. */
function uniquePath(dir: string, fileName: string): string {
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  let candidate = join(dir, fileName);
  for (let i = 1; existsSync(candidate) && i < 1000; i += 1) {
    candidate = join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/**
 * Resolves a Blackboard file reference to a URL that yields raw bytes.
 *
 * Blackboard serves files through a redirect chain:
 *   `/bbcswebdav/pid-.../xid-...`
 *     -> `alt-{tenant}.blackboard.com/bbcswebdav/...?one_hash=...&f_hash=...`
 *     -> Xythos presigned URL (the actual bytes)
 *
 * For PDFs the chain instead detours to `basic-doc-viewer.../documents?url=...`,
 * which returns a viewer page rather than the file. Forcing
 * `xythos-download=true` and dropping the inline-render flags keeps us on the
 * bytes path. The HTTP client follows the hops itself, re-attaching cookies per
 * host and refusing hosts outside the Blackboard allowlist.
 */
export function rawFileUrl(detail: BbFileDetail): string {
  const base = detail.permanentUrl ?? detail.viewerUrl;
  if (!base) {
    throw new BlackboardError('UNSUPPORTED', 'This file has no download URL.', {
      hint: 'The content item may be a link or an LTI placement rather than a stored file.',
    });
  }
  const [path, search = ''] = base.split('?');
  const params = new URLSearchParams(search);
  params.delete('render');
  params.delete('isInlineRender');
  params.set('xythos-download', 'true');
  return `${path}?${params.toString()}`;
}

export interface DownloadOptions {
  /** Directory to write into. Created if missing. */
  dir: string;
  fileName?: string;
  /** Refuse anything larger than this. */
  maxBytes: number;
  /** Expected size, when the caller already knows it: enables an early refusal. */
  expectedBytes?: number;
  /** Reuse an identical existing file instead of re-downloading. */
  reuseExisting?: boolean;
}

/** Fetches a Blackboard file to disk, with a size ceiling and dedupe. */
export async function downloadToDisk(
  http: HttpClient,
  url: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  if (opts.expectedBytes !== undefined && opts.expectedBytes > opts.maxBytes) {
    throw new BlackboardError(
      'BAD_INPUT',
      `File is ${fmtBytes(opts.expectedBytes)}, above the ${fmtBytes(opts.maxBytes)} limit.`,
      { hint: 'Raise maxDownloadBytes in your config, or set BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES.' },
    );
  }

  ensureDir(opts.dir);

  // A HEAD first would double the round trips against a redirect chain, so we
  // check Content-Length on the GET before buffering the whole body.
  const res = await http.request({ path: url, timeoutMs: 120_000 });
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > opts.maxBytes) {
    await res.body.body?.cancel().catch(() => {});
    throw new BlackboardError(
      'BAD_INPUT',
      `File is ${fmtBytes(declared)}, above the ${fmtBytes(opts.maxBytes)} limit.`,
      { hint: 'Raise maxDownloadBytes in your config to fetch it anyway.' },
    );
  }

  const data = Buffer.from(await res.body.arrayBuffer());
  if (data.byteLength > opts.maxBytes) {
    throw new BlackboardError(
      'BAD_INPUT',
      `File is ${fmtBytes(data.byteLength)}, above the ${fmtBytes(opts.maxBytes)} limit.`,
    );
  }

  const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream')
    .split(';')[0]!
    .trim();
  const fileName = safeFileName(
    opts.fileName ?? fileNameFromHeaders(res.headers) ?? basename(new URL(res.url).pathname),
  );
  const sha256 = createHash('sha256').update(data).digest('hex');

  // If the exact file is already there, don't write a duplicate.
  const direct = join(opts.dir, fileName);
  if (
    opts.reuseExisting !== false &&
    existsSync(direct) &&
    statSync(direct).size === data.byteLength
  ) {
    return {
      path: direct,
      fileName,
      bytes: data.byteLength,
      mimeType,
      sha256,
      cached: true,
      resolvedFrom: res.url,
    };
  }

  const target = uniquePath(opts.dir, fileName);
  writeFileSync(target, data, { mode: 0o600 });
  log.debug('Downloaded', { target, bytes: data.byteLength, mimeType });

  return {
    path: target,
    fileName: basename(target),
    bytes: data.byteLength,
    mimeType,
    sha256,
    cached: false,
    resolvedFrom: res.url,
  };
}

/** Reads a filename out of `Content-Disposition`, including the RFC 5987 form. */
export function fileNameFromHeaders(headers: Headers): string | undefined {
  const cd = headers.get('content-disposition');
  if (!cd) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1];
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Groups downloads by course so the download directory stays navigable. */
export function courseSubdir(root: string, courseLabel: string): string {
  return join(root, safeFileName(courseLabel, 'course').slice(0, 80));
}
