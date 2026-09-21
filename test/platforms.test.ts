import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRegistry, getPlatform, isPlatformEnvironment, platformDefinitions, platformIds, toolPlatform } from '../src/platforms/registry.js';
import { example } from '../src/platforms/_template/index.js';
import { planOverview } from '../src/platforms/overview.js';
import type { PlatformDefinition } from '../src/platforms/types.js';
import { Platform, ProfileFields, ProfileSchema, platforms, polyu } from '../src/config.js';
import { isAllowed, platformFor } from '../src/policy.js';
import { Backend } from '../src/backend.js';
import { configureEnvironment, validateCredential } from '../src/adapter.js';
import { LmsError } from '../src/errors.js';

test('registry is the source of platform schemas, config keys and exact tool ownership', () => {
  assert.deepEqual(Platform.options, platformIds);
  for (const definition of platformDefinitions) {
    const profile = ProfileSchema.parse({ id: 'school', label: 'School', timezone: 'UTC', [definition.id]: 'https://school.example.edu/' });
    assert.deepEqual(platforms(profile), [definition.id]);
    assert.equal(profile[definition.id], 'https://school.example.edu');
    assert(definition.id in ProfileFields);
    for (const name of definition.readTools) {
      assert.equal(platformFor(name), definition.id);
      assert(isAllowed(name, definition.id));
      for (const other of platformIds.filter(id => id !== definition.id)) assert.equal(isAllowed(name, other), false);
    }
  }
  for (const name of ['canvas_unknown', 'bb_submit_assignment', 'example_courses', 'constructor', '__proto__']) {
    assert.equal(toolPlatform(name), undefined);
    assert.throws(() => platformFor(name), (e: LmsError) => e.code === 'TOOL_NOT_ALLOWED');
  }
  assert.throws(() => getPlatform('example'), (e: LmsError) => e.code === 'UNSUPPORTED_PLATFORM');
  assert.equal(ProfileSchema.safeParse({ ...polyu, example: 'https://example.edu' }).success, false);
});

test('a third platform follows the same contract without importing or starting its runtime', () => {
  let loaded = false;
  const third = { ...example, loadRuntime: async () => { loaded = true; throw new Error('Must stay lazy'); } };
  const registry = createRegistry([...platformDefinitions, third]);
  assert.equal(registry.byTool.get('example_courses')?.id, 'example');
  assert.equal(registry.byId.get('example')?.label, 'Example LMS');
  assert.equal(loaded, false);
});

test('contribution mistakes fail closed: duplicates, reserved IDs, bad aliases and probes', () => {
  const invalid: PlatformDefinition[] = [
    { ...example, id: 'canvas' },
    { ...example, id: 'profiles' },
    { ...example, id: 'some-platform' },
    { ...example, readTools: ['canvas_list_courses'] },
    { ...example, readTools: ['example_courses', 'example_courses'] },
    { ...example, aliases: { write: 'example_submit' } },
    { ...example, probes: { ...example.probes, identity: { tool: 'example_unknown' } } },
    { ...example, environmentPrefixes: ['LMS_'] },
    { ...example, environmentPrefixes: [] },
    { ...example, login: { ...example.login, cookieNames: /example_session/g } },
    { ...example, login: { ...example.login, probePath: '//outside.example.edu/me' } },
  ];
  for (const definition of invalid) assert.throws(() => createRegistry([...platformDefinitions, definition]), /Invalid platform/);
});

test('overview composes more than eight reads and reports unsupported platforms explicitly', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const third: PlatformDefinition = { ...example, overview: () => ({ calls: [{ tool: 'example_courses' }], scope: { courseListOnly: true } }) };
  const combined = planOverview([...platformDefinitions, third], 14, now);
  assert.equal(combined.calls.length, 9);
  assert.deepEqual(combined.unsupportedPlatforms, []);
  assert.deepEqual(combined.scope.platforms.example, { courseListOnly: true });
  assert.deepEqual(combined.calls.find(call => call.tool === 'canvas_list_calendar_events')?.args, { start_date: '2026-09-21', end_date: '2026-10-05' });
  const missing = planOverview([example], 14, now);
  assert.deepEqual(missing.calls, []);
  assert.deepEqual(missing.unsupportedPlatforms, ['example']);
  assert.deepEqual(missing.scope.platforms.example, { supported: false, reason: 'No reviewed overview plan is available.' });
  for (const calls of [[], [{ tool: 'bb_submit_assignment' }], Array.from({ length: 9 }, () => ({ tool: 'example_courses' }))]) {
    assert.throws(() => planOverview([{ ...third, overview: () => ({ calls, scope: {} }) }], 14), (e: LmsError) => e.code === 'INVALID_PLATFORM_PLAN');
  }
});

test('backend filters foreign tools from each connector and does not guess a denied tool owner', async () => {
  const tools = ['canvas_list_courses', 'bb_list_courses', 'example_courses', 'bb_submit_assignment'].map(name => ({ name, inputSchema: { type: 'object' as const } }));
  const backend = new Backend(async () => ({ tools, call: async () => ({ content: [] }), close: async () => {} }), async () => 'synthetic');
  try {
    const catalog = await backend.catalog(polyu);
    assert.deepEqual(catalog.map(row => [row.platform, row.name]), [['canvas', 'canvas_list_courses'], ['blackboard', 'bb_list_courses']]);
    const result = await backend.batch(polyu, [{ tool: 'canvas_unknown' }, { tool: 'constructor' }]);
    assert(result.results.every(row => row.platform === null && row.error?.code === 'TOOL_NOT_ALLOWED'));
  } finally { await backend.close(); }
});

test('worker setup scrubs every upstream environment namespace, not just the chosen platform', async () => {
  const keys = ['CANVAS_COOKIE', 'BLACKBOARD_COOKIE', 'BLACKBOARD_MCP_ALLOW_WRITES', 'CANVAS_BASE_URL', 'CANVAS_NO_KEYCHAIN'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'inherited-secret';
    const { context } = await configureEnvironment(polyu, 'canvas');
    assert.equal(context.origin, polyu.canvas);
    assert.equal(process.env.CANVAS_BASE_URL, polyu.canvas);
    assert.equal(process.env.CANVAS_NO_KEYCHAIN, '1');
    for (const key of ['CANVAS_COOKIE', 'BLACKBOARD_COOKIE', 'BLACKBOARD_MCP_ALLOW_WRITES']) assert.equal(process.env[key], undefined);
    assert.equal(isPlatformEnvironment('LMS_HOME'), false);
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('invalid credentials are rejected before a platform runtime can use them', async () => {
  for (const candidate of [null, { kind: 'other', value: 'x' }, { kind: 'cookie', value: 'x\r\n' }, { kind: 'cookie', value: 'x', userAgent: 'x\r\nInjected: header' }]) {
    await assert.rejects(validateCredential(polyu, 'canvas', candidate as never), (e: LmsError) => e.code === 'BAD_INPUT');
  }
});

test('public core and platform metadata never import vendor implementations directly', async () => {
  for (const directory of ['../src/', '../src/auth/']) {
    for (const name of await readdir(new URL(directory, import.meta.url))) {
      if (!name.endsWith('.ts')) continue;
      const source = await readFile(new URL(`${directory}${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*vendor\//, name);
    }
  }
  for (const { id } of platformDefinitions) {
    const source = await readFile(new URL(`../src/platforms/${id}/index.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s*['"][^'"]*(?:vendor\/|runtime\.js)/, id);
  }
});
