import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Backend } from '../dist/src/backend.js';
import { addProfile, polyu } from '../dist/src/config.js';
import { platformDefinitions } from '../dist/src/platforms/registry.js';
const home = await mkdtemp(join(tmpdir(), 'lms-integration-')); process.env.LMS_HOME = home; process.env.LMS_UPDATE_CHECK = '0';
after(() => rm(home, { recursive: true, force: true }));
await addProfile(polyu);
test('real upstream MCP handshakes work offline and expose reviewed schemas', async () => {
  const b = new Backend();
  try {
    const catalog = await b.catalog(polyu); assert(catalog.length >= 50);
    assert(!catalog.some(t => /submit|save_quiz|start_quiz|raw_request|batch_request/.test(t.name)));
    const announcement = await b.catalog(polyu, { name: 'bb_announcements' }); assert(announcement[0]!.inputSchema);
    for (const definition of platformDefinitions) {
      for (const name of new Set([...Object.values(definition.aliases), definition.probes.identity.tool, definition.probes.courses.tool])) {
        assert(catalog.some(tool => tool.platform === definition.id && tool.name === name), `${definition.id}: missing declared tool ${name}`);
      }
    }
    const result = await b.call(polyu, 'canvas_list_courses'); assert.equal(result.error?.code, 'AUTH_REQUIRED');
    // Every precomposed overview argument must pass the actual upstream schema.
    const overview = await b.overview(polyu, 14); assert(overview.partial); assert.equal(overview.results.length, 8);
    assert(overview.results.every(r => r.error?.code === 'AUTH_REQUIRED'), JSON.stringify(overview.results.map(r => ({ tool: r.tool, error: r.error }))));
  } finally { await b.close(); }
});
test('public MCP server handles discovery, denied writes, profile listing and shutdown', async () => {
  const client = new Client({ name: 'acceptance-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'mcp'], env: { ...process.env as Record<string, string>, LMS_HOME: home }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport); const tools = (await client.listTools()).tools; assert.equal(tools.length, 17);
    assert(tools.some(t => t.name === 'lms_update_check'));
    assert(tools.some(t => t.name === 'lms_profile_add'));
    const search = await client.callTool({ name: 'lms_school_search', arguments: { query: '理大', offline: true } });
    assert.equal(search.isError, false);
    const searchData = JSON.parse((search.content as any[])[0].text);
    assert.equal(searchData.matches[0].platforms.canvas, 'https://canvas.polyu.edu.hk');
    assert.equal(searchData.sources.find((s: any) => s.source === 'canvas-directory').status, 'offline');
    const invalidSearch = await client.callTool({ name: 'lms_school_search', arguments: { query: 'https://school.edu?token=secret' } });
    assert.equal(invalidSearch.isError, true); assert.doesNotMatch(JSON.stringify(invalidSearch), /token=secret/);
    const profiles = await client.callTool({ name: 'lms_profiles', arguments: {} }); assert.equal(profiles.isError, false);
    const denied = await client.callTool({ name: 'lms_call', arguments: { tool: 'bb_submit_assignment', args: {} } }); assert.equal(denied.isError, true);
    const added = await client.callTool({ name: 'lms_profile_add', arguments: { id: 'mcp-school', label: 'MCP School', timezone: 'Europe/London', canvas: 'https://mcp.school.edu' } }); assert.equal(added.isError, false);
    const duplicate = await client.callTool({ name: 'lms_profile_add', arguments: { id: 'mcp-school', label: 'Overwrite', timezone: 'UTC', canvas: 'https://other.edu' } }); assert.equal(duplicate.isError, true);
    const use = await client.callTool({ name: 'lms_profile_use', arguments: { id: 'mcp-school' } }); assert.equal(use.isError, false);
    const unconfigured = await client.callTool({ name: 'lms_call', arguments: { profile: 'mcp-school', tool: 'bb_whoami' } });
    assert.equal(unconfigured.isError, true); assert.match(JSON.stringify(unconfigured), /NOT_CONFIGURED/); assert.doesNotMatch(JSON.stringify(unconfigured), /authorization/);
    const checked = await client.callTool({ name: 'lms_check', arguments: { profile: 'mcp-school' } });
    assert.equal(checked.isError, true); assert.match(JSON.stringify(checked), /AUTH_REQUIRED/);
    await client.callTool({ name: 'lms_profile_use', arguments: { id: 'polyu' } });
  } finally { await client.close(); }
});
test('CLI failure exit codes and JSON stay machine-readable', () => {
  const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LMS_HOME: home }, timeout: 30000 });
  const doctor = run(['doctor']); assert.equal(doctor.status, 0); assert.equal(JSON.parse(doctor.stdout).readOnly, true);
  const invalid = run(['call', 'bb_raw_request']); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).error.code, 'TOOL_NOT_ALLOWED');
  const missing = run(['canvas', 'courses']); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).error.code, 'AUTH_REQUIRED');
  const profilesHelp = run(['profiles', '--help']); assert.equal(profilesHelp.status, 0); assert(/\badd\b/.test(profilesHelp.stdout));
  const help = run(['init', '--help']);
  for (const definition of platformDefinitions) assert(help.stdout.includes(`--${definition.id} <origin>`));
  const otherSchool = run(['init', '--preset', 'other']); assert.equal(otherSchool.status, 1); assert.equal(JSON.parse(otherSchool.stdout).error.code, 'BAD_INPUT');
  const search = run(['schools', 'search', '理大', '--offline', '--platform', 'blackboard']);
  assert.equal(search.status, 0, search.stderr); assert.equal(search.stderr, '');
  assert.deepEqual(JSON.parse(search.stdout).matches[0].platforms, { blackboard: 'https://learn.polyu.edu.hk' });
  const setupHelp = run(['setup', '--help']); assert.match(setupHelp.stdout, /--school/); assert.match(setupHelp.stdout, /--manual/);
  const unattendedSearch = run(['setup', '--school', 'Example', '--yes', '--no-login', '--no-codex']);
  assert.equal(unattendedSearch.status, 1); assert.equal(JSON.parse(unattendedSearch.stdout).error.code, 'INPUT_REQUIRED');
});
test('CLI configures custom schools, supports single platforms and preserves existing PolyU state', async t => {
  const isolated = await mkdtemp(join(tmpdir(), 'lms-schools-')); t.after(() => rm(isolated, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LMS_HOME: isolated }, timeout: 30000 });
  const expect = (args: string[], status = 0) => { const r = run(args); assert.equal(r.status, status, r.stdout + r.stderr); return JSON.parse(r.stdout); };
  expect(['init', '--preset', 'polyu']);
  expect(['profiles', 'add', 'canvas-only', '--label', 'Canvas School', '--timezone', 'Europe/London', '--canvas', 'https://canvas.school.edu']);
  expect(['init', '--id', 'bb-only', '--label', 'Blackboard School', '--timezone', 'America/New_York', '--blackboard', 'https://learn.school.edu']);
  let config = expect(['profiles', 'list']); assert.equal(config.active, 'polyu'); assert.equal(config.profiles.length, 3);
  expect(['profiles', 'use', 'canvas-only']);
  expect(['init', '--preset', 'polyu']);
  config = expect(['profiles', 'list']); assert.equal(config.active, 'canvas-only'); assert.equal(config.profiles.length, 3);
  const absent = expect(['--profile', 'canvas-only', 'blackboard', 'courses'], 1); assert.equal(absent.error.code, 'NOT_CONFIGURED');
  const check = expect(['--profile', 'bb-only', 'check'], 1); assert.equal(check.profile, 'bb-only'); assert.equal(check.checks.length, 2); assert(check.checks.every((c: any) => c.platform === 'blackboard' && c.error.code === 'AUTH_REQUIRED'));
  const tools = expect(['--profile', 'canvas-only', 'tools']); assert(tools.length > 0); assert(tools.every((t: any) => t.platform === 'canvas'));
  expect(['init', '--preset', 'polyu', '--canvas', 'https://other.edu'], 1);
  expect(['init', '--id', 'invalid', '--label', 'Invalid', '--timezone', 'UTC'], 1);
  expect(['init', '--id', 'bad-url', '--label', 'Invalid URL', '--timezone', 'UTC', '--canvas', 'https://school.edu/login'], 1);
  assert.equal(expect(['profiles', 'list']).profiles.length, 3);
});

test('registering a synthetic third platform wires config, CLI, MCP, UI, vault and overview without core edits', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'lms-extension-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), join(fixture, 'dist'), { recursive: true });
  // A Windows junction does not require developer mode/admin privileges.
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  const registryPath = join(fixture, 'dist/src/platforms/registry.js');
  const registry = await readFile(registryPath, 'utf8');
  assert(registry.includes('[canvas, blackboard]'));
  // Only the copied registration point changes. The real source/tree stays untouched.
  await writeFile(registryPath, `import { example } from './_template/index.js';\n${registry.replace('[canvas, blackboard]', '[canvas, blackboard, example]')}`);
  const env = { ...process.env, LMS_HOME: join(fixture, 'state') };
  const cli = join(fixture, 'dist/src/cli.js');
  const added = spawnSync(process.execPath, [cli, 'init', '--id', 'third', '--label', 'Third Platform', '--timezone', 'UTC', '--example', 'https://third.example.edu'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(added.status, 0, added.stderr + added.stdout);
  assert.equal(JSON.parse(added.stdout).example, 'https://third.example.edu');
  const help = spawnSync(process.execPath, [cli, 'example', '--help'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /profile, courses/);
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(fixture, `dist/src/${name}.js`)).href);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { randomBytes } from 'node:crypto';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    import { ProfileSchema, Platform, polyu } from ${moduleUrl('config')};
    import { createMcp } from ${moduleUrl('mcp')};
    import { Backend } from ${moduleUrl('backend')};
    import { platformDefinitions, getPlatform } from ${moduleUrl('platforms/registry')};
    import { authorizationHTML } from ${moduleUrl('auth/ui')};
    import { cookieHeader } from ${moduleUrl('auth/cookies')};
    import { Vault } from ${moduleUrl('vault')};
    assert(Platform.options.includes('example'));
    assert(authorizationHTML().includes('Example LMS'));
    const p = ProfileSchema.parse({ id: 'third', label: 'Third', timezone: 'UTC', example: 'https://third.example.edu' });
    assert.equal(cookieHeader('example', p.example, [{ name: 'example_session', value: 'synthetic', domain: 'third.example.edu', secure: true }]), 'example_session=synthetic');
    const key = randomBytes(32);
    const vault = new Vault({ get: async () => key, set: async () => {} });
    await vault.write(p, 'example', { value: 'synthetic' });
    assert.equal(await vault.read({ ...p, example: 'https://other.example.edu' }, 'example'), null);
    assert.equal((await vault.read(p, 'example')).value.value, 'synthetic');
    let active = 0, maximum = 0;
    const b = new Backend(async (_profile, platform) => ({
      tools: getPlatform(platform).readTools.map(name => ({ name, inputSchema: { type: 'object', properties: { fixture: { type: 'integer' } } } })),
      call: async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 5)); active--; return { content: [] }; },
      close: async () => {},
    }), async () => 'synthetic-generation');
    assert.equal((await b.call(p, 'example_courses')).ok, true);
    const missing = await b.overview(p);
    assert.equal(missing.ok, false);
    assert.equal(missing.partial, true);
    assert.deepEqual(missing.unsupportedPlatforms, ['example']);
    // Supply deterministic fixture plans to exercise >8 internal reads with real Backend limits.
    for (const definition of platformDefinitions) definition.overview = () => ({
      calls: Array.from({ length: 3 }, (_, i) => ({ tool: definition.probes.courses.tool, args: { fixture: i } })), scope: {},
    });
    const overview = await b.overview({ ...polyu, ...p });
    assert.equal(overview.results.length, 9);
    assert.equal(overview.ok, true);
    assert(maximum <= 3 && maximum > 1);
    const instance = createMcp(b);
    const client = new Client({ name: 'extension-fixture', version: '1' });
    const [a, z] = InMemoryTransport.createLinkedPair();
    try {
      await instance.server.connect(z); await client.connect(a);
      const { tools } = await client.listTools();
      assert(tools.find(t => t.name === 'lms_profile_add').inputSchema.properties.example);
      assert(tools.find(t => t.name === 'lms_check').inputSchema.properties.platform.enum.includes('example'));
    } finally { await client.close(); await instance.close(); }
    console.log('Synthetic third-platform registration passed');
  `], { env, cwd: fixture, encoding: 'utf8', timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr + probe.stdout);
});
