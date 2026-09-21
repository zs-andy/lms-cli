import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { addProfile, getProfile, initProfile, loadConfig, polyu, ProfileSchema, Origin, useProfile } from '../src/config.js';
import { isFreshAuthorization } from '../src/auth/launch.js';
import { Vault, type KeyProvider } from '../src/vault.js';
import { cookieHeader, allowedNavigation } from '../src/auth/cookies.js';
import { isAllowed, platformFor } from '../src/policy.js';
import { publicError, LmsError } from '../src/errors.js';
import { exportCalendar, listItems, upsertItems } from '../src/items.js';
import { codexArguments } from '../src/ask.js';

const home = await mkdtemp(join(tmpdir(), 'lms-unit-')); process.env.LMS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
class MemoryKey implements KeyProvider { key: Buffer | null = null; async get() { return this.key; } async set(k: Buffer) { this.key = k; } }
const key = new MemoryKey(); const vault = new Vault(key);
const p = ProfileSchema.parse(polyu);
test('HTTPS origins reject userinfo, insecure URLs, paths, and token query strings', () => {
  for (const bad of ['http://school.edu', 'https://me:secret@school.edu', 'https://school.edu/login', 'https://school.edu?token=abc', 'file:///etc/passwd']) assert.equal(Origin.safeParse(bad).success, false);
  assert.equal(Origin.parse('https://school.edu/'), 'https://school.edu');
});
test('profile config isolates schools and refuses accidental replacement', async () => {
  await addProfile(p); await addProfile({ id: 'second', label: 'Another', timezone: 'Europe/London', canvas: 'https://other.instructure.com' });
  await assert.rejects(addProfile(p), (e: LmsError) => e.code === 'PROFILE_EXISTS');
  await useProfile('second'); assert.equal((await getProfile()).id, 'second'); assert.equal((await getProfile('polyu')).blackboard, polyu.blackboard);
  assert.equal((await loadConfig()).profiles.length, 2);
  assert.equal(ProfileSchema.safeParse({ ...p, timezone: 'Mars/Test' }).success, false);
  assert.equal(ProfileSchema.safeParse({ ...p, id: '../escape' }).success, false);
});
test('vault encrypts secrets and authenticates school, slot and generation', async () => {
  const generation = await vault.write(p, 'canvas', { secret: 'SYNTHETIC-COOKIE-ONLY' });
  const loaded = await vault.read<{ secret: string }>(p, 'canvas'); assert.equal(loaded?.value.secret, 'SYNTHETIC-COOKIE-ONLY'); assert.equal(loaded?.generation, generation);
  const legacyName = createHash('sha256').update(`${p.id}\0canvas\0${p.canvas ?? ''}\0${p.blackboard ?? ''}`).digest('hex');
  assert.equal(JSON.parse(await readFile(join(home, `${legacyName}.vault`), 'utf8')).generation, generation, 'Existing v0.2/v0.3 vault paths must not change');
  const files = (await readdir(home)).filter(f => f.endsWith('.vault'));
  for (const file of files) assert.equal((await readFile(join(home, file), 'utf8')).includes('SYNTHETIC'), false);
  assert.equal(await vault.read({ ...p, id: 'other-account' }, 'canvas'), null);
  assert.equal(await vault.read({ ...p, canvas: 'https://different.example.edu' }, 'canvas'), null);
  const file = join(home, files[0]!); const envelope = JSON.parse(await readFile(file, 'utf8')); envelope.generation = 'tampered'; await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(vault.read(p, 'canvas'), (e: LmsError) => e.code === 'VAULT_INVALID');
});
test('custom setup supports either platform, validates timezone and preserves the active account', async () => {
  const current = (await loadConfig()).active;
  const custom = await initProfile({ id: 'bb-only', label: ' BlackBoard School ', timezone: 'America/New_York', blackboard: 'https://learn.school.edu/' });
  assert.equal(custom.canvas, undefined); assert.equal(custom.blackboard, 'https://learn.school.edu'); assert.equal(custom.label, 'BlackBoard School');
  assert.equal((await loadConfig()).active, current);
  assert.deepEqual(await initProfile({ preset: 'polyu' }), p);
  for (const invalid of [{}, { id: 'bad', label: 'Missing platform', timezone: 'UTC' }, { ...p, id: 'bad', timezone: 'Mars/Test' }, { ...p, label: '  ' }]) await assert.rejects(initProfile(invalid), (e: LmsError) => e.code === 'BAD_INPUT');
  await assert.rejects(initProfile({ preset: 'polyu', canvas: 'https://other.edu' }), (e: LmsError) => e.code === 'BAD_INPUT');
  await assert.rejects(initProfile({ preset: 'unknown' }), (e: LmsError) => e.code === 'BAD_INPUT');
  await assert.rejects(getProfile('missing'), (e: LmsError) => e.code === 'PROFILE_NOT_FOUND' && !e.message.includes('PolyU'));
});
test('reauthorization cannot finish using old or another platform\'s saved credentials', () => {
  const started = '2026-09-21T00:00:00Z';
  const old = { platform: 'canvas' as const, authorized: true, validatedAt: '2026-09-20T23:59:59Z', liveChecked: false };
  assert.equal(isFreshAuthorization([old], ['canvas'], started), false);
  const fresh = { ...old, validatedAt: started };
  assert.equal(isFreshAuthorization([fresh], ['canvas'], started), true);
  assert.equal(isFreshAuthorization([fresh], ['blackboard'], started), false);
  assert.equal(isFreshAuthorization([fresh], ['canvas', 'blackboard'], started), false);
  assert.equal(isFreshAuthorization([{ ...fresh, authorized: false }], ['canvas'], started), false);
});
test('cookie extraction works for custom schools without sharing another tenant session', () => {
  const cookie = { name: 'canvas_session', value: 'synthetic', domain: 'alpha.instructure.com', secure: true };
  assert.equal(cookieHeader('canvas', 'https://alpha.instructure.com', [cookie]), 'canvas_session=synthetic');
  assert.equal(cookieHeader('canvas', 'https://beta.instructure.com', [cookie]), null);
  assert.equal(cookieHeader('blackboard', 'https://learn.school.edu', [{ ...cookie, name: 'JSESSIONID', domain: 'learn.school.edu' }]), 'JSESSIONID=synthetic');
});
test('old workers cannot replace new login or restore logged-out credentials', async () => {
  const first = await vault.write(p, 'canvas', { n: 1 }); const second = await vault.write(p, 'canvas', { n: 2 });
  assert.notEqual(first, second); assert.equal(await vault.write(p, 'canvas', { n: 99 }, first!), null);
  assert.equal((await vault.read<{ n: number }>(p, 'canvas'))?.value.n, 2);
  await vault.remove(p, 'canvas'); assert.equal(await vault.write(p, 'canvas', { n: 99 }, second!), null);
});
test('keychain failure has no plaintext or key-file fallback', async () => {
  const unavailable = new Vault({ get: async () => { throw new Error('sensitive native detail'); }, set: async () => {} });
  await assert.rejects(unavailable.write(p, 'canvas', { private: true }), (e: LmsError) => e.code === 'KEYCHAIN_UNAVAILABLE');
  assert.equal(await vault.generation(p, 'canvas'), null);
});
test('cookie scoping excludes IdP, sibling host, expired and injected values', () => {
  const base = { name: 'canvas_session', value: 'sample', domain: 'canvas.polyu.edu.hk', path: '/', secure: true };
  const cookies = [base, { ...base, domain: 'login.microsoftonline.com', value: 'idp' }, { ...base, name: 'password', value: 'notallowed' }, { ...base, domain: 'evilcanvas.polyu.edu.hk', value: 'sibling' }];
  assert.equal(cookieHeader('canvas', p.canvas!, cookies), 'canvas_session=sample');
  assert.equal(cookieHeader('canvas', p.canvas!, [{ ...base, secure: false }]), null);
  assert.equal(cookieHeader('canvas', p.canvas!, [{ ...base, expirationDate: 1 }]), null);
  assert.equal(cookieHeader('canvas', p.canvas!, [{ ...base, value: 'a;password=x' }]), null);
  assert.equal(cookieHeader('canvas', p.canvas!, [{ ...base, path: '/api/v10' }]), null);
  assert.equal(cookieHeader('canvas', p.canvas!, [{ ...base, domain: '.polyu.edu.hk' }]), 'canvas_session=sample');
  assert.equal(allowedNavigation('https://login.school.edu/mfa'), true);
  for (const url of ['http://school.edu', 'file:///tmp/x', 'javascript:alert(1)', 'https://name:password@school.edu']) assert.equal(allowedNavigation(url), false);
});
test('remote writes, browser import and raw request escape hatches are denied', () => {
  for (const name of ['bb_raw_request', 'bb_batch_request', 'bb_mark_reviewed', 'bb_submit_assignment', 'bb_start_quiz_attempt', 'bb_save_quiz_answer', 'bb_download_file', 'invented_tool']) { assert.equal(isAllowed(name), false); assert.throws(() => platformFor(name)); }
  assert.equal(platformFor('canvas_list_courses'), 'canvas'); assert.equal(platformFor('bb_announcements'), 'blackboard');
});
test('unknown error details never reach the client', () => {
  assert.equal(JSON.stringify(publicError(new Error('cookie=super-secret'))).includes('super-secret'), false);
});
test('tasks preserve completion and history across due-date corrections', async () => {
  const item = { id: 'canvas:3805:10486:homework1', title: 'Homework 1', kind: 'assignment', due: '2026-10-02T18:00:00+08:00', status: 'done', notes: 'my note', sources: [{ url: 'https://canvas.polyu.edu.hk/courses/3805/discussion_topics/10486', quote: 'Due 2 October at 18:00' }] };
  await upsertItems(p, [item], vault);
  await upsertItems(p, [{ ...item, due: '2026-10-03T18:00:00+08:00', status: undefined, notes: undefined }], vault);
  const items = await listItems(p, vault); assert.equal(items.length, 1); assert.equal(items[0]!.status, 'done'); assert.equal(items[0]!.notes, 'my note'); assert.equal(items[0]!.history[0]!.due, item.due);
  await assert.rejects(upsertItems(p, [{ ...item, due: 'next Friday' }], vault));
  await assert.rejects(upsertItems(p, [{ ...item, sources: [] }], vault));
});
test('concurrent local upserts do not drop another task', async () => {
  const base = { title: 'Check', kind: 'other', sources: [{ url: 'https://school.edu/notice', quote: 'Check your work' }] };
  await Promise.all([upsertItems(p, [{ ...base, id: 'a' }], vault), upsertItems(p, [{ ...base, id: 'b' }], vault)]);
  const items = await listItems(p, vault); assert(items.some(i => i.id === 'a')); assert(items.some(i => i.id === 'b'));
});
test('ICS preserves instants, stable UIDs and excludes ambiguous tasks', async () => {
  const items = await listItems(p, vault); const exported = exportCalendar(p, items);
  assert(exported.ics.includes('DTSTART:20261003T100000Z')); assert.equal(exported.excluded.length, 2);
  const uid = exported.ics.match(/UID:([^\r\n]+)/)![1];
  const changed = structuredClone(items); changed[0]!.due = '2026-10-04T18:00:00+08:00';
  assert.equal(exportCalendar(p, changed).ics.match(/UID:([^\r\n]+)/)![1], uid);
  changed[0]!.needsConfirmation = true; assert.equal(exportCalendar(p, changed).excluded.length, 3);
});
test('ask uses isolated Codex invocation with no shell, credentials or approval bypass', () => {
  const args = codexArguments(p, '/tmp/example', '/tmp/example/answer.txt');
  assert(args.includes('--ignore-user-config')); assert(args.includes('read-only')); assert(args.includes('shell_tool'));
  assert(!args.join(' ').includes('dangerously')); assert(!args.join(' ').includes('CANVAS_COOKIE'));
});
