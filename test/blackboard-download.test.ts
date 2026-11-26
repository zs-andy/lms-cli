import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Session } from '../vendor/blackboard/src/auth/session.js';
import { ConfigSchema } from '../vendor/blackboard/src/config.js';
import { BlackboardClient, HttpClient } from '../vendor/blackboard/src/client/index.js';
import { saveBlackboardFile } from '../vendor/blackboard/src/download.js';
import { Backend } from '../src/backend.js';
import { addProfile, polyu } from '../src/config.js';
import { createMcp } from '../src/mcp.js';

const origin = 'https://learn.school.example.edu';
const pdf = Buffer.from('%PDF-1.7\nblackboard original bytes\n%%EOF');

async function createTestClient() {
  const session = await Session.fromCookieHeader(origin, 'BbRouter=synthetic-bb-cookie; JSESSIONID=synthetic-jsid', {
    userAgent: 'lms-test-agent',
  });
  session.persist = async () => {};
  const config = ConfigSchema.parse({ baseUrl: origin, allowWrites: false });
  return new BlackboardClient(new HttpClient(session, config), config);
}

interface FixtureOptions {
  content?: Record<string, unknown>;
  attachments?: Array<Record<string, unknown>>;
  body?: () => Response;
}

async function fixture(t: TestContext, opts: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bb-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = await createTestClient();
  const content = opts.content ?? {
    id: '_456_1',
    title: 'Week 1 Lecture',
    contentHandler: 'resource/x-bb-file',
    contentDetail: {
      'resource/x-bb-file': {
        file: {
          fileName: 'lecture.pdf',
          mimeType: 'application/pdf',
          fileSize: pdf.length,
          permanentUrl: '/bbcswebdav/pid-456-dt-content-rid-999_1/xid-999_1',
        },
      },
    },
  };
  const attachments = opts.attachments ?? [];
  const makeBody = opts.body ?? (() => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }));

  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/attachments') && !url.includes('/download')) {
      return Response.json({ results: attachments });
    }
    if (url.includes('/contents/_456_1') && !url.includes('/attachments')) {
      return Response.json(content);
    }
    return makeBody();
  });

  return { client, options: { courseId: '_123_1', contentId: '_456_1', directory } };
}

test('streams exact original bytes and SHA-256; duplicate downloads preserve old files', async t => {
  const { client, options } = await fixture(t);
  const first = await saveBlackboardFile(client, options);
  assert.deepEqual(await readFile(first.path), pdf);
  assert.equal(first.bytes, pdf.length);
  assert.equal(first.sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(first.filename, 'lecture.pdf');
  assert.equal(first.courseId, '_123_1');
  assert.equal(first.contentId, '_456_1');
  assert(first.source_url.startsWith(`${origin}/bbcswebdav/`));

  const second = await saveBlackboardFile(client, options);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(first.path), pdf);
  assert.equal(second.filename, 'lecture (_456_1).pdf');
  assert.deepEqual((await readdir(options.directory)).sort(), ['lecture (_456_1).pdf', 'lecture.pdf']);

  await assert.rejects(saveBlackboardFile(client, { ...options, on_conflict: 'error' }), /DOWNLOAD_EXISTS/);
});

test('simultaneous identical downloads publish distinct complete files', async t => {
  const { client, options } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => saveBlackboardFile(client, options)));
  assert.equal(new Set(results.map(r => r.path)).size, 4);
  for (const result of results) assert.deepEqual(await readFile(result.path), pdf);
  assert.equal((await readdir(options.directory)).length, 4);
});

test('existing symlink destinations are never followed or replaced', async t => {
  const { client, options } = await fixture(t);
  await writeFile(join(options.directory, 'original'), 'keep');
  await symlink(join(options.directory, 'original'), join(options.directory, 'lecture.pdf'));
  const result = await saveBlackboardFile(client, options);
  assert.equal(result.filename, 'lecture (_456_1).pdf');
  assert.equal(await readFile(join(options.directory, 'original'), 'utf8'), 'keep');
});

test('resolves attachments and embedded files and selects via source_file', async t => {
  const zipBytes = Buffer.from('PK\x03\x04synthetic-zip');
  const { client, options } = await fixture(t, {
    content: {
      id: '_456_1',
      title: 'Assignment Pack',
      contentHandler: 'resource/x-bb-document',
      body: { displayText: '<p><a href="/bbcswebdav/pid-1/xid-2/starter.zip">Starter</a></p>' },
    },
    attachments: [
      { id: '_att_1', fileName: 'rubric.pdf', mimeType: 'application/pdf', size: pdf.length },
      { id: '_att_2', fileName: 'dataset.zip', mimeType: 'application/zip', size: zipBytes.length },
    ],
    body: () => new Response(zipBytes, { headers: { 'content-type': 'application/zip' } }),
  });

  const saved = await saveBlackboardFile(client, { ...options, source_file: 'dataset' });
  assert.equal(saved.filename, 'dataset.zip');
  assert.deepEqual(await readFile(saved.path), zipBytes);

  await assert.rejects(saveBlackboardFile(client, { ...options, source_file: 'missing.docx' }), /No file matching/);
});

test('HTML sign-in responses, unexpected HTML, and wrong PDF bytes are never published', async t => {
  for (const [body, code] of [
    ['<html><form>Sign in password</form></html>', /AUTH_REQUIRED/],
    ['<html>Service unavailable</html>', /DOWNLOAD_INVALID/],
    ['not a pdf', /DOWNLOAD_INVALID/],
  ] as const) {
    await t.test(body, async t => {
      const { client, options } = await fixture(t, {
        body: () => new Response(body, { headers: { 'content-type': body.startsWith('<html') ? 'text/html' : 'application/pdf' } }),
      });
      await assert.rejects(saveBlackboardFile(client, options), code);
      assert.deepEqual(await readdir(options.directory), []);
    });
  }
});

test('incomplete and interrupted streams clean up temporary files', async t => {
  await t.test('metadata size mismatch', async t => {
    const { client, options } = await fixture(t, {
      body: () => new Response('%PDF-truncated', { headers: { 'content-type': 'application/pdf' } }),
    });
    await assert.rejects(saveBlackboardFile(client, options), /DOWNLOAD_INCOMPLETE/);
    assert.deepEqual(await readdir(options.directory), []);
  });
  await t.test('stream interruption', async t => {
    const { client, options } = await fixture(t, {
      body: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(pdf.subarray(0, 8));
              controller.error(new Error('connection lost'));
            },
          }),
          { headers: { 'content-type': 'application/pdf' } },
        ),
    });
    await assert.rejects(saveBlackboardFile(client, options), /connection lost/);
    assert.deepEqual(await readdir(options.directory), []);
  });
});

test('byte cap applies pre-fetch and mid-stream when metadata underreports size', async t => {
  const { client, options } = await fixture(t, {
    body: () => new Response(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500)])),
  });
  await assert.rejects(saveBlackboardFile(client, { ...options, max_bytes: 100 }), /DOWNLOAD_LIMIT/);
  assert.deepEqual(await readdir(options.directory), []);
  await assert.rejects(saveBlackboardFile(client, { ...options, max_bytes: 1 }), /DOWNLOAD_LIMIT/);
});

test('invalid inputs and traversal filenames are rejected; unsafe filename characters are sanitized', async t => {
  const { client, options } = await fixture(t);
  await assert.rejects(saveBlackboardFile(client, { ...options, directory: 'relative' }), /DOWNLOAD_INPUT/);
  await assert.rejects(saveBlackboardFile(client, { ...options, courseId: '../bad' }), /DOWNLOAD_INPUT/);
  await assert.rejects(saveBlackboardFile(client, { ...options, contentId: '' }), /DOWNLOAD_INPUT/);
  await assert.rejects(saveBlackboardFile(client, { ...options, filename: '../escape.pdf' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveBlackboardFile(client, { ...options, filename: '..\\escape.pdf' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveBlackboardFile(client, { ...options, filename: '.' }), /DOWNLOAD_FILENAME/);
  await assert.rejects(saveBlackboardFile(client, { ...options, filename: '..' }), /DOWNLOAD_FILENAME/);
  const result = await saveBlackboardFile(client, { ...options, filename: 'user:file.pdf' });
  assert.equal(result.filename, 'user_file.pdf');
});

test('external-only content items are rejected as NOT_FOUND without fetching external hosts', async t => {
  const fetched: string[] = [];
  const { client, options } = await fixture(t, {
    content: {
      id: '_456_1',
      title: 'Slides Link',
      contentHandler: 'resource/x-bb-externallink',
      contentDetail: { 'resource/x-bb-externallink': { url: 'https://docs.google.com/presentation/d/abc/edit' } },
    },
  });
  const origFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    fetched.push(String(input));
    return origFetch(input, init);
  });
  await assert.rejects(saveBlackboardFile(client, options), /no downloadable Blackboard file/);
  assert(!fetched.some(url => url.includes('google.com')));
});

test('off-origin CDN redirects never receive Blackboard cookies; login redirects require auth', async t => {
  const { client, options } = await fixture(t);
  const captured: Array<[string, RequestInit | undefined]> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const target = String(input);
    captured.push([target, init]);
    if (target.includes('/attachments')) return Response.json({ results: [] });
    if (target.includes('/contents/_456_1')) {
      return Response.json({
        id: '_456_1',
        contentHandler: 'resource/x-bb-file',
        contentDetail: {
          'resource/x-bb-file': {
            file: {
              fileName: 'lecture.pdf',
              mimeType: 'application/pdf',
              fileSize: pdf.length,
              permanentUrl: '/bbcswebdav/pid-456/xid-999_1',
            },
          },
        },
      });
    }
    if (target.includes('learn.school.example.edu/bbcswebdav/')) {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.bbcdn.io/xythos/signed-download' } });
    }
    return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
  });

  await saveBlackboardFile(client, options);
  const originHop = captured.find(([url]) => url.includes('/bbcswebdav/'));
  const cdnHop = captured.find(([url]) => url.includes('cdn.bbcdn.io'));
  assert(originHop);
  assert(cdnHop);
  assert.match((originHop[1]!.headers as Record<string, string>).Cookie, /BbRouter=synthetic-bb-cookie/);
  assert.deepEqual(cdnHop[1]!.headers, {});

  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const target = String(input);
    if (target.includes('/attachments')) return Response.json({ results: [] });
    if (target.includes('/contents/_456_1')) {
      return Response.json({
        id: '_456_1',
        contentHandler: 'resource/x-bb-file',
        contentDetail: {
          'resource/x-bb-file': {
            file: { fileName: 'lecture.pdf', mimeType: 'application/pdf', fileSize: pdf.length, permanentUrl: '/bbcswebdav/xid-1' },
          },
        },
      });
    }
    return new Response(null, { status: 302, headers: { location: '/webapps/login/?action=relogin' } });
  });
  await assert.rejects(saveBlackboardFile(client, options), /AUTH_REQUIRED/);
});

test('local Blackboard downloads are neither cached nor coalesced by Backend', async () => {
  let calls = 0;
  const b = new Backend(
    async () => ({
      tools: [{ name: 'bb_download_file', inputSchema: { type: 'object', properties: {} } }],
      call: async () => {
        calls++;
        return { content: [{ type: 'text', text: '{}' }] };
      },
      close: async () => {},
    }),
    async () => 'synthetic-generation',
  );
  try {
    const result = await Promise.all(Array.from({ length: 3 }, () => b.call(polyu, 'bb_download_file')));
    assert.equal(calls, 3);
    assert(result.every(r => r.ok && !r.cached));
    await b.call(polyu, 'bb_download_file');
    assert.equal(calls, 4);
  } finally {
    await b.close();
  }
});

test('MCP lms_download_file validates Canvas/Blackboard arguments cleanly and rejects bb_download_file in lms_call/lms_batch', async t => {
  const prevHome = process.env.LMS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'bb-mcp-dl-'));
  process.env.LMS_HOME = home;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.LMS_HOME;
    else process.env.LMS_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });
  await addProfile(polyu);

  const backend = new Backend(
    async () => ({
      tools: [
        { name: 'canvas_download_file', inputSchema: { type: 'object', properties: {} } },
        { name: 'bb_download_file', inputSchema: { type: 'object', properties: {} } },
      ],
      call: async () => ({ content: [{ type: 'text', text: '{}' }] }),
      close: async () => {},
    }),
    async () => 'synthetic-generation',
  );
  const instance = createMcp(backend);
  const client = new Client({ name: 'bb-dl-test', version: '1' });
  const [a, z] = InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(z);
    await client.connect(a);

    const callDenied = await client.callTool({ name: 'lms_call', arguments: { tool: 'bb_download_file', args: {} } });
    assert.equal(callDenied.isError, true);
    assert.match(JSON.stringify(callDenied), /LOCAL_FILE_TOOL/);

    const batchDenied = await client.callTool({ name: 'lms_batch', arguments: { calls: [{ tool: 'bb_download_file', args: {} }] } });
    assert.equal(batchDenied.isError, true);
    assert.match(JSON.stringify(batchDenied), /LOCAL_FILE_TOOL/);

    const mixed = await client.callTool({
      name: 'lms_download_file',
      arguments: { file_id: 42, courseId: '_123_1', contentId: '_456_1', directory: home },
    });
    assert.equal(mixed.isError, true);
    assert.match(JSON.stringify(mixed), /DOWNLOAD_INPUT/);

    const missingCourse = await client.callTool({
      name: 'lms_download_file',
      arguments: { platform: 'blackboard', contentId: '_456_1', directory: home },
    });
    assert.equal(missingCourse.isError, true);
    assert.match(JSON.stringify(missingCourse), /DOWNLOAD_INPUT/);
  } finally {
    await client.close();
    await instance.close();
  }
});
