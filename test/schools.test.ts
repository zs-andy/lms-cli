import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANVAS_DIRECTORY, directoryOrigin, searchSchools, type SchoolMatch } from '../src/schools.js';
import { selectSchool } from '../src/school-selection.js';
import { chooseProfile } from '../src/setup.js';
import { loadConfig } from '../src/config.js';

const home = await mkdtemp(join(tmpdir(), 'lms-schools-'));
const previousHome = process.env.LMS_HOME;
process.env.LMS_HOME = home;
after(async () => { if (previousHome === undefined) delete process.env.LMS_HOME; else process.env.LMS_HOME = previousHome; await rm(home, { recursive: true, force: true }); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const noNetwork: typeof fetch = async () => { throw new Error('Network must not be called'); };
const example: SchoolMatch = { id: 'canvas:canvas.example.edu', name: 'Example University', source: 'canvas-directory', platforms: { canvas: 'https://canvas.example.edu' } };
const answer = (...values: string[]) => async () => { assert.ok(values.length, 'unexpected terminal question'); return values.shift()!; };
const silent = () => {};

test('online search uses only the public directory, no credentials, redirects or profile writes', async () => {
  let called = 0;
  const result = await searchSchools('Example University', {}, async (input, init) => {
    called++;
    const url = new URL(String(input));
    assert.equal(`${url.origin}${url.pathname}`, CANVAS_DIRECTORY);
    assert.equal(url.searchParams.get('name'), 'Example University');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal); assert.deepEqual(Object.keys(init?.headers ?? {}).sort(), ['Accept', 'User-Agent']);
    return json([{ name: example.name, domain: 'canvas.example.edu' }]);
  });
  assert.equal(called, 1); assert.deepEqual(result.matches, [example]);
  assert.equal(result.sources.find(s => s.source === 'blackboard-directory')?.status, 'unsupported');
  assert.deepEqual(await readdir(home), []);
});

test('domain search selects the documented domain parameter and normalizes the result', async () => {
  const result = await searchSchools('Canvas.Example.edu', { platform: 'canvas' }, async input => {
    assert.equal(new URL(String(input)).searchParams.get('domain'), 'Canvas.Example.edu');
    return json([{ name: ' Example University ', domain: 'Canvas.Example.edu' }]);
  });
  assert.deepEqual(result.matches, [example]); assert.equal(result.partial, false);
});

test('offline presets support Chinese aliases and platform filtering with no requests', async t => {
  const fetcher = t.mock.fn(noNetwork);
  for (const query of ['理大', '香港理工大学', '香港理工大學', 'polyu']) {
    const result = await searchSchools(query, { platform: 'blackboard', offline: true }, fetcher);
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0]?.platforms, { blackboard: 'https://learn.polyu.edu.hk' });
    assert.equal(result.matches[0]?.timezone, 'Asia/Hong_Kong');
    assert.equal(result.sources.some(s => s.source === 'canvas-directory'), false);
  }
  const result = await searchSchools('polyu', { offline: true }, fetcher);
  assert.equal(result.sources.find(s => s.source === 'canvas-directory')?.status, 'offline');
  await searchSchools('Unknown School', { platform: 'blackboard' }, fetcher);
  assert.equal(fetcher.mock.callCount(), 0);
});

test('directory timeout is bounded and preserves the manual fallback and presets', async t => {
  let duration = 0;
  const timeout = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    duration = milliseconds;
    return AbortSignal.abort(new DOMException('Request timed out', 'TimeoutError'));
  });
  const result = await searchSchools('polyu', {}, async (_input, init) => {
    init!.signal!.throwIfAborted(); return json([]);
  });
  assert.equal(timeout.mock.callCount(), 1); assert.equal(duration, 5000); assert.equal(result.partial, true);
  assert.equal(result.matches[0]?.source, 'preset');
  assert.equal(result.sources.find(s => s.source === 'canvas-directory')?.status, 'unavailable');
});

test('directory results are limited to twenty distinct domains in the first hundred rows', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ name: `School ${i}`, domain: `canvas${i}.example.edu` }));
  const result = await searchSchools('School', { platform: 'canvas' }, async () => json(rows));
  assert.equal(result.matches.length, 20); assert.equal(result.matches[19]?.name, 'School 19');
  const late = await searchSchools('School', { platform: 'canvas' }, async () => json([...Array(100).fill(null), rows[0]]));
  assert.equal(late.matches.length, 0);
});

test('directory errors remain distinct from empty successful search, with presets preserved', async () => {
  for (const fetcher of [async () => { throw new Error('private diagnostics'); }, async () => new Response('rate limited', { status: 429 }), async () => json({ unexpected: [] }), async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })]) {
    const result = await searchSchools('polyu', {}, fetcher);
    assert.equal(result.matches[0]?.source, 'preset'); assert.equal(result.partial, true);
    assert.equal(result.sources.find(s => s.source === 'canvas-directory')?.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('private diagnostics'), false);
  }
  const empty = await searchSchools('Unknown School', { platform: 'canvas' }, async () => json([]));
  assert.equal(empty.partial, false); assert.deepEqual(empty.matches, []);
});

test('unsafe directory domains and terminal injection are rejected; SSO variants are deduplicated', async () => {
  const bad = ['127.0.0.1', '2130706433', 'localhost', 'school.local', 'school.test', 'school.edu/login', 'me@school.edu', 'school.edu?token=x', 'school.edu#x', 'school.edu:443', 'school.edu\\evil', 'https://school.edu', '-school.edu', 'school.edu\n'];
  for (const domain of bad) assert.equal(directoryOrigin(domain), undefined, domain);
  const result = await searchSchools('Example', {}, async () => json([
    ...bad.map(domain => ({ name: 'Bad', domain })),
    { name: '\u001b[2JInjected', domain: 'unsafe.edu' },
    { name: 'Hidden\u202eSchool', domain: 'unsafe.edu' },
    { name: example.name, domain: 'canvas.example.edu', authentication_provider: 'saml' },
    { name: 'Guest', domain: 'canvas.example.edu', authentication_provider: 'canvas' },
    null, 'bad', { name: 'x'.repeat(101), domain: 'long.edu' },
  ]));
  assert.deepEqual(result.matches, [example]);
});

test('response size is bounded both by headers and by actual streamed bytes', async () => {
  for (const response of [new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '9999999' } }), json('x'.repeat(300000))]) {
    const result = await searchSchools('Example', {}, async () => response);
    assert.equal(result.sources.find(s => s.source === 'canvas-directory')?.status, 'unavailable');
  }
});

test('invalid search inputs fail before network access', async () => {
  for (const query of ['', 'a', 'x'.repeat(121), '\u001bSchool', 'https://user:secret@school.edu', 'school.edu?token=secret']) {
    await assert.rejects(searchSchools(query, {}, noNetwork), { code: 'BAD_INPUT' });
  }
  await assert.rejects(searchSchools('Example', { platform: 'moodle' as any }, noNetwork), { code: 'BAD_INPUT' });
});

test('terminal selection requires a valid explicit number and does not auto-pick a single result', async () => {
  const prompts: string[] = [];
  const result = await selectSchool('Example', {}, async message => { prompts.push(message); return prompts.length === 1 ? '99' : '1'; }, async () => ({ ok: true, query: 'Example', matches: [example], sources: [], partial: false, note: 'Confirm URLs' }), silent);
  assert.deepEqual(result, example); assert.equal(prompts.length, 2);
});

test('selection supports re-search, manual fallback and cancel without saving', async () => {
  const seen: string[] = [];
  const search = async (query: string) => { seen.push(query); return { ok: true as const, query, matches: query === 'Other' ? [example] : [], sources: [], partial: false, note: '' }; };
  assert.deepEqual(await selectSchool('Missing', {}, answer('r', 'Other', '1'), search, silent), example);
  assert.deepEqual(seen, ['Missing', 'Other']);
  assert.equal(await selectSchool('Missing', {}, answer('m'), search, silent), undefined);
  assert.equal(await selectSchool(undefined, {}, answer(''), search, silent), undefined);
  await assert.rejects(selectSchool('Missing', {}, answer('q'), search, silent), { code: 'CANCELLED' });
});

test('setup cannot choose search results with --yes, or mix sources', async () => {
  for (const options of [{ school: 'Example', yes: true }, { school: 'Example', canvas: 'https://other.edu' }, { school: 'Example', preset: 'polyu' }, { school: 'Example', manual: true }, { school: 'Example', profile: 'other' }]) {
    await assert.rejects(chooseProfile(options, answer(), async () => true, async () => { assert.fail('selection must not run'); }));
  }
  assert.deepEqual(await readdir(home), []);
});

test('selected school is confirmed with timezone, reused on repeat, and never replaces the active school', async () => {
  let approved = '';
  const first = await chooseProfile({ school: 'Example' }, answer('Europe/London'), async message => { approved = message; return true; }, async () => example);
  assert.equal(first.canvas, example.platforms.canvas); assert.equal(first.label, example.name);
  assert.ok(approved.includes('https://canvas.example.edu')); assert.ok(approved.includes('Europe/London'));
  const repeat = await chooseProfile({ school: 'Example' }, answer('Europe/London'), async () => true, async () => example);
  assert.deepEqual(first, repeat);
  const second = await chooseProfile({ school: 'Other', timezone: 'UTC' }, answer(), async () => true, async () => ({ ...example, name: 'Other', platforms: { blackboard: 'https://learn.other.edu' } }));
  assert.notEqual(second.id, first.id); assert.equal((await loadConfig()).active, first.id);
  assert.deepEqual(await chooseProfile({}, answer(), async () => { assert.fail('existing default must be reused'); }), first);
});

test('rejecting the selected school leaves configuration unchanged', async () => {
  const before = await loadConfig();
  await assert.rejects(chooseProfile({ school: 'Example', id: 'cancelled', timezone: 'UTC' }, answer(), async () => false, async () => example), { code: 'CANCELLED' });
  assert.deepEqual(await loadConfig(), before);
});

test('setup with only account metadata still offers school discovery', async () => {
  let searched = false;
  const result = await chooseProfile({ id: 'metadata-only', timezone: 'UTC', offline: true }, answer(), async () => true, async (query, options) => {
    assert.equal(query, undefined); assert.equal(options?.offline, true); searched = true; return example;
  });
  assert.equal(searched, true); assert.equal(result.id, 'metadata-only');
});

test('invalid interactive search can be corrected or switched to manual input', async () => {
  assert.equal(await selectSchool('https://school.edu', { offline: true }, answer(''), searchSchools, silent), undefined);
  assert.equal(await selectSchool('x', { offline: true }, answer('polyu', '1'), searchSchools, silent).then(s => s?.id), 'preset:polyu');
});
