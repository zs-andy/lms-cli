import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canvasDownloadResponse, canvasGet, baseUrl } from './canvas.js';

export interface DownloadOptions {
  file_id: number;
  directory: string;
  filename?: string;
  on_conflict?: 'rename' | 'error';
  max_bytes?: number;
}

export function safeFilename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+/, '_');
  const name = cleaned || 'download';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? `_${name}` : name;
  if (Buffer.byteLength(reserved) > 220) throw new Error('DOWNLOAD_FILENAME: Choose a shorter filename.');
  return reserved;
}

/** Stream into a private temporary directory, then publish with an atomic no-replace link. */
export async function saveCanvasFile(options: DownloadOptions) {
  if (!Number.isSafeInteger(options.file_id) || options.file_id <= 0 || !isAbsolute(options.directory)) {
    throw new Error('DOWNLOAD_INPUT: A positive file ID and absolute directory are required.');
  }
  if (options.filename && (basename(options.filename) !== options.filename || /[/\\]/.test(options.filename))) {
    throw new Error('DOWNLOAD_FILENAME: Filename must not contain a directory.');
  }
  const meta = await canvasGet(`/files/${options.file_id}`);
  if (meta.locked_for_user || meta.hidden_for_user) throw new Error('403: Canvas has restricted this file.');
  const maxBytes = options.max_bytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) throw new Error('DOWNLOAD_INPUT: Invalid byte limit.');
  if (meta.size > maxBytes) throw new Error('DOWNLOAD_LIMIT: File exceeds the configured byte limit.');
  const filename = safeFilename(options.filename ?? meta.display_name ?? meta.filename ?? `canvas-${options.file_id}`);
  const directory = resolve(options.directory);
  const signal = AbortSignal.timeout(300_000);
  const response = await canvasDownloadResponse(meta.url, signal);
  let staging: string | undefined;
  try {
    if (!response.body) throw new Error('DOWNLOAD_INVALID: Download has no body.');
    await mkdir(directory, { recursive: true });
    staging = await mkdtemp(join(directory, '.lms-download-'));
    const temporary = join(staging, 'content.part');
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) { done(new Error('DOWNLOAD_LIMIT: Download exceeds the configured byte limit.')); return; }
      hash.update(chunk);
      if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 - prefix.length)]);
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), meter,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    const actualType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
    const expectedType = meta['content-type'] ?? '';
    const looksHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(prefix.toString('utf8'));
    if ((actualType === 'text/html' || looksHtml) && expectedType !== 'text/html') {
      if (/login|sign[ -]?in|password|saml|adfs/i.test(prefix.toString('utf8'))) throw new Error('AUTH_REQUIRED: Download returned a school sign-in page.');
      throw new Error('DOWNLOAD_INVALID: HTML was returned instead of the requested file.');
    }
    if ((expectedType === 'application/pdf' || /\.pdf$/i.test(meta.filename ?? meta.display_name ?? '')) && !prefix.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Error('DOWNLOAD_INVALID: Download is not a PDF.');
    }
    if (Number.isSafeInteger(meta.size) && bytes !== meta.size) throw new Error('DOWNLOAD_INCOMPLETE: Downloaded size does not match Canvas metadata.');
    const extension = extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const name = attempt ? `${stem} (${options.file_id}${attempt > 1 ? `-${attempt}` : ''})${extension}` : filename;
      const path = join(directory, name);
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (options.on_conflict === 'error') throw new Error('DOWNLOAD_EXISTS: A file with that name already exists.');
        continue;
      }
      return { file_id: options.file_id, path, filename: name, content_type: expectedType || actualType,
        bytes, sha256: hash.digest('hex'), source_url: `${baseUrl()}/files/${options.file_id}`, downloaded_at: new Date().toISOString() };
    }
    throw new Error('DOWNLOAD_EXISTS: Too many files with the same name.');
  } finally {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
