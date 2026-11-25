import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCanvasFile } from '../vendor/canvas/src/download.js';
import { listCourseFiles } from '../vendor/canvas/src/files.js';
import { Backend } from '../src/backend.js';
import { polyu } from '../src/config.js';

process.env.CANVAS_BASE_URL = 'https://school.example.edu';
process.env.CANVAS_API_TOKEN = 'synthetic-test-token';
process.env.CANVAS_NO_KEYCHAIN = '1';
const pdf = Buffer.from('%PDF-1.7\nexample original bytes\n%%EOF');
async function fixture(t: TestContext, body: () => Response = () => new Response(pdf)) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).includes('/api/v1/files/') ? Response.json({
    id: 42, display_name: 'lecture.pdf', filename: 'lecture.pdf', 'content-type': 'application/pdf', size: pdf.length,
    url: 'https://school.example.edu/files/42/download',
  }) : body());
  return { file_id: 42, directory };
}

test('streams exact original bytes and SHA-256; duplicate downloads preserve old files', async t => {
  const options = await fixture(t);
  const first = await saveCanvasFile(options);
  assert.deepEqual(await readFile(first.path), pdf);
  assert.equal(first.bytes, pdf.length);
  assert.equal(first.sha256, createHash('sha256').update(pdf).digest('hex'));
  const second = await saveCanvasFile(options);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(first.path), pdf);
  assert.equal(second.filename, 'lecture (42).pdf');
  assert.deepEqual((await readdir(options.directory)).sort(), ['lecture (42).pdf', 'lecture.pdf']);
  await assert.rejects(saveCanvasFile({ ...options, on_conflict: 'error' }), /DOWNLOAD_EXISTS/);
});

test('simultaneous identical downloads publish distinct complete files', async t => {
  const options = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => saveCanvasFile(options)));
  assert.equal(new Set(results.map(r => r.path)).size, 4);
  for (const result of results) assert.deepEqual(await readFile(result.path), pdf);
  assert.equal((await readdir(options.directory)).length, 4);
});

test('existing symlink destinations are never followed or replaced', async t => {
  const options = await fixture(t);
  await writeFile(join(options.directory, 'original'), 'keep');
  await symlink(join(options.directory, 'original'), join(options.directory, 'lecture.pdf'));
  const result = await saveCanvasFile(options);
  assert.equal(result.filename, 'lecture (42).pdf');
  assert.equal(await readFile(join(options.directory, 'original'), 'utf8'), 'keep');
});

test('HTML sign-in responses and wrong PDF bytes are never published', async t => {
  for (const [body, code] of [
    ['<html><form>Sign in password</form></html>', /AUTH_REQUIRED/],
    ['<html>Service unavailable</html>', /DOWNLOAD_INVALID/],
    ['not a pdf', /DOWNLOAD_INVALID/],
  ] as const) {
    await t.test(body, async t => {
      const options = await fixture(t, () => new Response(body));
      await assert.rejects(saveCanvasFile(options), code);
      assert.deepEqual(await readdir(options.directory), []);
    });
  }
});

test('incomplete and interrupted streams remove temporary files', async t => {
  await t.test('size mismatch', async t => {
    const options = await fixture(t, () => new Response('%PDF-truncated'));
    await assert.rejects(saveCanvasFile(options), /DOWNLOAD_INCOMPLETE/);
    assert.deepEqual(await readdir(options.directory), []);
  });
  await t.test('stream interruption', async t => {
    const options = await fixture(t, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(pdf.subarray(0, 8)); controller.error(new Error('connection lost')); },
    })));
    await assert.rejects(saveCanvasFile(options), /connection lost/);
    assert.deepEqual(await readdir(options.directory), []);
  });
});

test('byte cap applies even when Canvas metadata underreports the size', async t => {
  const options = await fixture(t, () => new Response(Buffer.alloc(500)));
  await assert.rejects(saveCanvasFile({ ...options, max_bytes: 100 }), /DOWNLOAD_LIMIT/);
  assert.deepEqual(await readdir(options.directory), []);
  await assert.rejects(saveCanvasFile({ ...options, max_bytes: 1 }), /DOWNLOAD_LIMIT/);
});

test('invalid paths are rejected and server filenames cannot escape the selected directory', async t => {
  const options = await fixture(t);
  await assert.rejects(saveCanvasFile({ ...options, directory: 'relative' }), /DOWNLOAD_INPUT/);
  await assert.rejects(saveCanvasFile({ ...options, filename: '../escape.pdf' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveCanvasFile({ ...options, filename: '..\\escape.pdf' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveCanvasFile({ ...options, filename: '.' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveCanvasFile({ ...options, filename: '..' }), /DOWNLOAD_FILENAME/);
  const result = await saveCanvasFile({ ...options, filename: 'user:file.pdf' });
  assert.equal(result.filename, 'user_file.pdf');
});

test('missing download URL is rejected cleanly as forbidden', async t => {
  const options = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 42, display_name: 'lecture.pdf', size: pdf.length, url: null }));
  await assert.rejects(saveCanvasFile(options), /403/);
});

test('redirected CDN downloads do not receive Canvas credentials; login redirects require auth', async t => {
  const options = await fixture(t);
  const captured: Array<[string, RequestInit | undefined]> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url); captured.push([target, init]);
    if (target.includes('/api/v1/files/')) return Response.json({ display_name: 'lecture.pdf', size: pdf.length, 'content-type': 'application/pdf', url: 'https://school.example.edu/files/42/download' });
    if (target.includes('school.example.edu/files/')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.edu/original' } });
    return new Response(pdf);
  });
  await saveCanvasFile(options);
  assert.equal((captured[1]![1]!.headers as Record<string, string>).Authorization, 'Bearer synthetic-test-token');
  assert.deepEqual(captured[2]![1]!.headers, {});
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).includes('/api/v1/files/') ? Response.json({
    display_name: 'lecture.pdf', size: pdf.length, url: 'https://school.example.edu/files/42/download',
  }) : new Response(null, { status: 302, headers: { location: '/login/canvas' } }));
  await assert.rejects(saveCanvasFile(options), /AUTH_REQUIRED/);
});

test('403 file lists fall back to module items and course page links, with coverage limits', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path.endsWith('/files')) return new Response('{}', { status: 403 });
    if (path.endsWith('/modules')) return Response.json([{ id: 7, items_count: 2, items: [] }]);
    if (path.endsWith('/modules/7/items')) return Response.json([{ type: 'File', content_id: 42, title: 'lecture.pdf' }, { type: 'Page', page_url: 'resources' }]);
    if (path.endsWith('/pages/resources')) return Response.json({ body: '<a href="/courses/9/files/43/download">Handout.pdf</a><a data-api-endpoint="/api/v1/files/44">Other</a><a href="https://evil.example/files/99">ignore.pdf</a>' });
    throw new Error('Unexpected request');
  });
  const result = await listCourseFiles(9);
  assert.deepEqual(result.rows.map((r: any) => r.id), [42, 43, 44]);
  assert.match(result.note!, /403/); assert.match(result.note!, /not a complete/);
  assert(calls.every(path => path.startsWith('/api/v1/courses/9/')));
  const filtered = await listCourseFiles(9, 'lecture'); assert.equal(filtered.rows.length, 1);
});

test('403 on every discovery path remains a failure; 401 does not trigger fallback', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 403 }); });
  await assert.rejects(listCourseFiles(9), /403/);
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 401 }); });
  await assert.rejects(listCourseFiles(9), /401/); assert.equal(calls, 1);
});

test('local downloads are neither cached nor coalesced by Backend', async () => {
  let calls = 0;
  const b = new Backend(async () => ({
    tools: [{ name: 'canvas_download_file', inputSchema: { type: 'object', properties: {} } }],
    call: async () => { calls++; return { content: [{ type: 'text', text: '{}' }] }; }, close: async () => {},
  }), async () => 'synthetic-generation');
  try {
    const result = await Promise.all(Array.from({ length: 3 }, () => b.call(polyu, 'canvas_download_file')));
    assert.equal(calls, 3); assert(result.every(r => r.ok && !r.cached));
    await b.call(polyu, 'canvas_download_file'); assert.equal(calls, 4);
  } finally { await b.close(); }
});
