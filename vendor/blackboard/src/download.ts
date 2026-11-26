import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Session } from './auth/session.js';
import { fileDetailOf, type BlackboardClient, type BbContent } from './client/index.js';
import { BlackboardError } from './lib/errors.js';
import { extractEmbeddedFiles } from './lib/extract.js';
import { fileNameFromHeaders, rawFileUrl } from './lib/files.js';

export interface BlackboardDownloadOptions {
  courseId: string;
  contentId: string;
  directory: string;
  source_file?: string;
  filename?: string;
  on_conflict?: 'rename' | 'error';
  max_bytes?: number;
}

export interface BlackboardFileTarget {
  url: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  source: 'contentDetail' | 'attachment' | 'embedded';
}

export interface BlackboardSavedFile {
  courseId: string;
  contentId: string;
  path: string;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  source_url: string;
  downloaded_at: string;
}

const LOGIN_PATH_MARKERS = [
  '/webapps/login',
  '/auth-saml/saml/login',
  '/adfs/ls',
  '/login.jsp',
  '/oidcAuth',
];

function looksLikeLoginUrl(target: URL): boolean {
  const pathAndQuery = target.pathname + target.search;
  if (LOGIN_PATH_MARKERS.some((marker) => pathAndQuery.startsWith(marker) || pathAndQuery.includes(marker))) {
    return true;
  }
  return /^\/(login|logout|saml|sso)(\/|$)/i.test(target.pathname);
}

export function safeFilename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+/, '_');
  const name = cleaned || 'download';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? `_${name}` : name;
  if (Buffer.byteLength(reserved) > 220) throw new Error('DOWNLOAD_FILENAME: Choose a shorter filename.');
  return reserved;
}

/**
 * Finds Blackboard-hosted downloadable files attached to or embedded in one content item.
 * External third-party links (e.g. Google Docs/Slides) are intentionally excluded.
 */
export async function resolveBlackboardFileTargets(
  client: BlackboardClient,
  courseId: string,
  contentId: string,
): Promise<{ item: BbContent; targets: BlackboardFileTarget[] }> {
  const item = await client.getContent(courseId, contentId);
  const targets: BlackboardFileTarget[] = [];

  const detail = fileDetailOf(item);
  if (detail?.permanentUrl || detail?.viewerUrl) {
    targets.push({
      url: rawFileUrl(detail),
      fileName: detail.fileName ?? '',
      mimeType: detail.mimeType,
      size: detail.fileSize,
      source: 'contentDetail',
    });
  }

  try {
    for (const att of await client.listAttachments(courseId, contentId)) {
      targets.push({
        url: client.attachmentDownloadPath(courseId, contentId, att.id),
        fileName: att.fileName ?? att.id,
        mimeType: att.mimeType,
        size: att.size,
        source: 'attachment',
      });
    }
  } catch (err) {
    if (err instanceof BlackboardError && (err.code === 'SESSION_EXPIRED' || err.code === 'NOT_AUTHENTICATED')) {
      throw err;
    }
    // Tenants without the attachments sub-resource return 404/403; not fatal.
  }

  const bodyHtml = item.body?.displayText ?? item.body?.rawText ?? '';
  for (const emb of extractEmbeddedFiles(bodyHtml)) {
    if (targets.some((t) => t.url.split('?')[0] === emb.url.split('?')[0])) continue;
    let decoded = 'embedded';
    try {
      decoded = decodeURIComponent(basename(emb.url.split('?')[0]!)) || 'embedded';
    } catch {
      decoded = basename(emb.url.split('?')[0]!) || 'embedded';
    }
    targets.push({
      url: `${emb.url}${emb.url.includes('?') ? '&' : '?'}xythos-download=true`,
      fileName: decoded,
      source: 'embedded',
    });
  }

  return { item, targets };
}

function pickTarget(targets: BlackboardFileTarget[], wanted: string | undefined): BlackboardFileTarget {
  if (targets.length === 0) {
    throw new BlackboardError('NOT_FOUND', 'This content item has no downloadable Blackboard file.', {
      hint: 'Use bb_get_content to inspect the item. External links, folders, and LTI tools cannot be downloaded.',
    });
  }
  if (!wanted) return targets[0]!;
  const needle = wanted.toLowerCase();
  const hit = targets.find((t) => t.fileName.toLowerCase().includes(needle));
  if (!hit) {
    throw new BlackboardError('NOT_FOUND', `No file matching "${wanted}" on this content item.`);
  }
  return hit;
}

/**
 * Download a file from a Blackboard-issued URL with strict redirect credential isolation.
 * Only same-origin Blackboard requests carry session cookies; off-origin CDN / Xythos /
 * S3 / CloudFront redirects are fetched with empty headers.
 */
export async function blackboardDownloadResponse(
  session: Session,
  fileUrl: string,
  signal = AbortSignal.timeout(300_000),
): Promise<Response> {
  const baseOrigin = new URL(session.baseUrl).origin;
  let url = /^https?:\/\//i.test(fileUrl)
    ? fileUrl
    : new URL(fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`, session.baseUrl).toString();

  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new Error('DOWNLOAD_INVALID: Refusing an insecure Blackboard file download URL.');
    }
    if (looksLikeLoginUrl(target)) {
      throw new Error('AUTH_REQUIRED: Blackboard download requires school sign-in.');
    }
    const sameHost = target.origin === baseOrigin;
    const headers: Record<string, string> = sameHost
      ? {
          ...(session.userAgent ? { 'User-Agent': session.userAgent } : {}),
          Cookie: await session.cookieHeader(target.toString()),
        }
      : {};

    const res = await fetch(url, {
      headers,
      redirect: 'manual',
      signal,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error(`Download failed (${res.status}) without a location header.`);
      url = new URL(location, target).toString();
      continue;
    }

    if (res.status === 401) {
      await res.body?.cancel();
      throw new Error('AUTH_REQUIRED: Blackboard download requires school sign-in.');
    }
    if (res.status === 403) {
      const diagnostic = await res.text().catch(() => '');
      if (/session|login|authenticat/i.test(diagnostic)) {
        throw new Error('AUTH_REQUIRED: Blackboard download requires school sign-in.');
      }
      throw new BlackboardError('FORBIDDEN', 'Blackboard denied access to this file.', { status: 403 });
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new BlackboardError('NOT_FOUND', 'Blackboard could not find this file.', { status: 404 });
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Download failed (${res.status} ${res.statusText}) for ${target.pathname}`);
    }
    return res;
  }

  throw new Error('Too many redirects while downloading the file.');
}

/** Stream into a private temporary directory, validate, then publish with an atomic no-replace link. */
export async function saveBlackboardFile(
  client: BlackboardClient,
  options: BlackboardDownloadOptions,
): Promise<BlackboardSavedFile> {
  const validId = /^[^\s/\\\x00-\x1f]+$/;
  if (!validId.test(options.courseId) || !validId.test(options.contentId) || !isAbsolute(options.directory)) {
    throw new Error('DOWNLOAD_INPUT: Valid courseId, contentId, and an absolute directory are required.');
  }
  if (
    options.filename &&
    (options.filename === '.' ||
      options.filename === '..' ||
      basename(options.filename) !== options.filename ||
      /[/\\]/.test(options.filename))
  ) {
    throw new Error('DOWNLOAD_FILENAME: Filename must not contain a directory.');
  }
  const maxBytes = options.max_bytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) {
    throw new Error('DOWNLOAD_INPUT: Invalid byte limit.');
  }

  const { targets } = await resolveBlackboardFileTargets(client, options.courseId, options.contentId);
  const target = pickTarget(targets, options.source_file);
  if (Number.isSafeInteger(target.size) && target.size! > maxBytes) {
    throw new Error('DOWNLOAD_LIMIT: File exceeds the configured byte limit.');
  }

  const resolvedSource = /^https?:\/\//i.test(target.url)
    ? new URL(target.url)
    : new URL(target.url.startsWith('/') ? target.url : `/${target.url}`, client.http.session.baseUrl);
  if (resolvedSource.protocol !== 'https:' || resolvedSource.username || resolvedSource.password) {
    throw new Error('DOWNLOAD_INVALID: Refusing an insecure Blackboard file download URL.');
  }

  const directory = resolve(options.directory);
  const signal = AbortSignal.timeout(300_000);
  const response = await blackboardDownloadResponse(client.http.session, target.url, signal);

  let staging: string | undefined;
  try {
    if (!response.body) throw new Error('DOWNLOAD_INVALID: Download has no body.');
    const rawContentLength = response.headers.get('content-length');
    const declaredLength = rawContentLength !== null && /^\d+$/.test(rawContentLength.trim()) ? Number(rawContentLength.trim()) : undefined;
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      throw new Error('DOWNLOAD_LIMIT: File exceeds the configured byte limit.');
    }

    const headerName = fileNameFromHeaders(response.headers);
    const fallbackName = target.fileName || headerName || `blackboard-${options.contentId}`;
    const filename = safeFilename(options.filename ?? fallbackName);

    await mkdir(directory, { recursive: true });
    staging = await mkdtemp(join(directory, '.lms-download-'));
    const temporary = join(staging, 'content.part');

    let bytes = 0;
    let prefix = Buffer.alloc(0);
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          done(new Error('DOWNLOAD_LIMIT: Download exceeds the configured byte limit.'));
          return;
        }
        hash.update(chunk);
        if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 - prefix.length)]);
        done(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      meter,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal },
    );

    const actualType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const expectedType = (target.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const prefixText = prefix.toString('utf8');
    const looksHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(prefixText);
    const expectedHtml = expectedType === 'text/html' || /\.html?$/i.test(target.fileName);

    if ((actualType === 'text/html' || looksHtml) && !expectedHtml) {
      if (/login|sign[ -]?in|password|saml|adfs/i.test(prefixText)) {
        throw new Error('AUTH_REQUIRED: Download returned a school sign-in page.');
      }
      throw new Error('DOWNLOAD_INVALID: HTML was returned instead of the requested file.');
    }

    if ((expectedType === 'application/pdf' || /\.pdf$/i.test(target.fileName)) && !prefix.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Error('DOWNLOAD_INVALID: Download is not a PDF.');
    }

    if (Number.isSafeInteger(target.size) && target.size! > 0 && bytes !== target.size) {
      throw new Error('DOWNLOAD_INCOMPLETE: Downloaded size does not match Blackboard metadata.');
    }
    if (declaredLength !== undefined && declaredLength > 0 && bytes !== declaredLength) {
      throw new Error('DOWNLOAD_INCOMPLETE: Downloaded size does not match response Content-Length.');
    }

    const extension = extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    const tag = safeFilename(options.contentId);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = attempt ? `${stem} (${tag}${attempt > 1 ? `-${attempt}` : ''})${extension}` : filename;
      const path = join(directory, name);
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (options.on_conflict === 'error') throw new Error('DOWNLOAD_EXISTS: A file with that name already exists.');
        continue;
      }
      return {
        courseId: options.courseId,
        contentId: options.contentId,
        path,
        filename: name,
        content_type: expectedType || actualType || 'application/octet-stream',
        bytes,
        sha256: hash.digest('hex'),
        source_url: resolvedSource.toString(),
        downloaded_at: new Date().toISOString(),
      };
    }

    throw new Error('DOWNLOAD_EXISTS: Too many files with the same name.');
  } finally {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
