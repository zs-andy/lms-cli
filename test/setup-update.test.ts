import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion, inspectRelease, checkForUpdates, portableAsset, RELEASES_URL, RELEASE_API } from '../src/updates.js';
import { expectedChecksum, safeArchiveEntry, safeTag, installationRoot, rollback } from '../src/upgrade.js';
import { chooseProfile } from '../src/setup.js';
import { loadConfig, addProfile } from '../src/config.js';
import { connectCodex, LOCAL_PLUGIN } from '../dist/src/codex.js';
import { mcpConfig } from '../dist/src/runtime.js';
import { VERSION } from '../src/version.js';

const home = await mkdtemp(join(tmpdir(), 'lms-setup-tests-')); process.env.LMS_HOME = home; process.env.LMS_UPDATE_CHECK = '0';
after(() => rm(home, { recursive: true, force: true }));
const release = (version = '9.0.0', platform = process.platform, arch = process.arch) => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [portableAsset(version, platform, arch)!, 'SHA256SUMS.txt'].map(name => ({ name, state: 'uploaded', browser_download_url: `${RELEASES_URL}/download/v${version}/${name}` })),
});

test('semantic versions handle numeric components, prereleases and local metadata without downgrades', () => {
  for (const [newer, older] of [['0.10.0', '0.9.0'], ['1.0.0', '1.0.0-beta.11'], ['1.0.0-beta.11', '1.0.0-beta.2'], ['1.0.0-beta', '1.0.0-1'], ['1.0.0-alpha.1', '1.0.0-alpha']]) assert.equal(compareVersions(newer!, older!), 1);
  assert.equal(compareVersions('v1.0.0+codex.123', '1.0.0+other'), 0);
  for (const bad of ['1.01.0', '1.0', '1.0.0-01', '1.0.0;echo hi', '../../1.0.0', '99999999999999999.0.0', '1.0.0\n']) assert.equal(parseVersion(bad), null, bad);
  assert.equal(safeTag('v1.0.0'), true); assert.equal(safeTag('v1.0.0-beta'), false); assert.equal(safeTag('v1.0.0+dev'), false);
});

test('update selection is pinned to the exact OS, architecture, repository and complete release assets', () => {
  const result = inspectRelease(release(), VERSION);
  assert.equal(result.status, 'available'); assert.equal(result.asset?.name, portableAsset('9.0.0')); assert(result.checksumUrl);
  assert.equal(inspectRelease(release(VERSION)).status, 'current');
  assert.equal(inspectRelease(release('0.1.0')).status, 'ahead');
  const noChecksum = release(); noChecksum.assets.pop(); assert.equal(inspectRelease(noChecksum).asset, undefined);
  const foreign = release(); foreign.assets[0]!.browser_download_url = 'https://evil.example/install.sh'; assert.equal(inspectRelease(foreign).asset, undefined);
  assert.equal(inspectRelease(release('9.0.0', 'win32', 'x64'), VERSION, 'darwin', 'arm64').asset, undefined);
  assert.equal(inspectRelease(null).status, 'no-release');
  assert.throws(() => inspectRelease({ ...release(), draft: true }));
  assert.throws(() => inspectRelease({ ...release(), prerelease: true }));
  assert.throws(() => inspectRelease({ ...release(), tag_name: 'v9.0.0/../../bad' }));
});

test('update checks fail softly, respect opt-out and send no school configuration', async () => {
  let calls = 0;
  const fetcher = (async (url: any, init: any) => {
    calls++; assert.equal(url, RELEASE_API); assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent']);
    assert(!JSON.stringify(init).includes('school'));
    return new Response(JSON.stringify(release()), { status: 200 });
  }) as typeof fetch;
  assert.equal((await checkForUpdates({ automatic: true, fetcher })).status, 'disabled'); assert.equal(calls, 0);
  assert.equal((await checkForUpdates({ fetcher })).status, 'available'); assert.equal(calls, 1);
  for (const response of [new Response('', { status: 429 }), new Response('not-json'), new Response('a'.repeat(1024 * 1024 + 1))]) assert.equal((await checkForUpdates({ fetcher: (async () => response) as typeof fetch })).status, 'unavailable');
  assert.equal((await checkForUpdates({ fetcher: (async () => { throw new Error('private diagnostic'); }) as typeof fetch })).status, 'unavailable');
  assert.equal((await checkForUpdates({ fetcher: (async () => new Response('', { status: 404 })) as typeof fetch })).status, 'no-release');
});

test('checksums and archive traversal/link escapes fail closed', () => {
  const digest = 'a'.repeat(64);
  assert.equal(expectedChecksum(`${digest}  package.tar.gz\n`, 'package.tar.gz'), digest);
  assert.throws(() => expectedChecksum(`${digest}  other.tar.gz`, 'package.tar.gz'));
  assert.throws(() => expectedChecksum(`${digest}  x\n${digest}  x`, 'x'));
  for (const path of ['/etc/cron', '../outside', 'app/../../outside', 'app\\..\\escape', 'app/file:stream', 'app/evil\nfile', 'C:/outside', 'other/file']) assert.equal(safeArchiveEntry(path, 'File'), false, path);
  assert.equal(safeArchiveEntry('app/node_modules/example/index.js', 'File'), true);
  assert.equal(safeArchiveEntry('app/file', 'SymbolicLink', '../../outside'), false);
  assert.equal(safeArchiveEntry('app/link', 'SymbolicLink', '/tmp/file'), false);
  assert.equal(safeArchiveEntry('app/link', 'SymbolicLink', 'file'), true);
  assert.equal(safeArchiveEntry('app/link', 'Link', '../outside'), false);
  assert.equal(safeArchiveEntry('app/device', 'CharacterDevice'), false);
});

test('setup generates IDs, is repeatable, preserves defaults and never overwrites an account', async () => {
  const input = { yes: true, label: 'Example', canvas: 'https://canvas.example.edu', timezone: 'Asia/Hong_Kong' };
  const p = await chooseProfile(input); assert.equal(p.id, 'canvas-example-edu');
  assert.equal((await chooseProfile(input)).id, p.id); assert.equal((await loadConfig()).profiles.length, 1);
  await chooseProfile({ yes: true, label: 'Exchange', blackboard: 'https://learn.other.edu', timezone: 'Europe/London' });
  assert.equal((await loadConfig()).active, p.id); assert.equal((await chooseProfile({ yes: true })).id, p.id);
  await assert.rejects(chooseProfile({ ...input, id: p.id, canvas: 'https://wrong.edu' }), (e: any) => e.code === 'PROFILE_EXISTS');
  await assert.rejects(chooseProfile({ yes: true, canvas: input.canvas }), (e: any) => e.code === 'INPUT_REQUIRED');
  await assert.rejects(chooseProfile({ ...input, preset: 'polyu' }), (e: any) => e.code === 'BAD_INPUT');
  await assert.rejects(chooseProfile({ ...input, profile: p.id }), (e: any) => e.code === 'BAD_INPUT');
  await assert.rejects(chooseProfile({ ...input, canvas: 'https://canvas.example.edu/login' }), (e: any) => e.code === 'BAD_INPUT');
  const before = (await loadConfig()).profiles.length;
  await assert.rejects(chooseProfile({ preset: 'polyu' }, async () => '', async () => false), (e: any) => e.code === 'CANCELLED');
  assert.equal((await loadConfig()).profiles.length, before);
});

test('setup in non-interactive mode never guesses a school or asks for credentials', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'lms-setup-cli-'));
  try {
    const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, LMS_HOME: isolated }, encoding: 'utf8', timeout: 20000 });
    const missing = run(['setup', '--yes', '--no-login', '--no-codex']); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).error.code, 'INPUT_REQUIRED');
    const args = ['setup', '--preset', 'polyu', '--yes', '--no-login', '--no-codex'];
    const first = run(args); assert.equal(first.status, 0, first.stdout + first.stderr); assert.equal(JSON.parse(first.stdout).ready, false);
    const before = await readFile(join(isolated, 'profiles.json'), 'utf8');
    await writeFile(join(isolated, 'synthetic.vault'), 'untouched');
    assert.equal(run(args).status, 0); assert.equal(await readFile(join(isolated, 'profiles.json'), 'utf8'), before);
    assert.equal(await readFile(join(isolated, 'synthetic.vault'), 'utf8'), 'untouched');
    assert.equal(run(['setup', '--help']).status, 0);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});

test('generated Codex integration uses absolute runtime paths and refuses unconfirmed plugin replacement', async () => {
  const calls: string[][] = [];
  let installed: any[] = [{ name: 'lms-cli', pluginId: 'lms-cli@personal', enabled: true }];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'list') return { installed };
    if (args[1] === 'add') {
      const manifest = JSON.parse(await readFile(join(home, 'codex-integration/plugins/lms-cli/.codex-plugin/plugin.json'), 'utf8'));
      installed.push({ name: 'lms-cli', pluginId: LOCAL_PLUGIN, enabled: true, version: manifest.version });
    }
    if (args[1] === 'remove') installed = installed.filter(p => p.pluginId !== args[2]);
    return {};
  };
  await assert.rejects(connectCodex({ runner }), (e: any) => e.code === 'PLUGIN_CONFLICT'); assert.equal(calls.length, 1);
  const result = await connectCodex({ runner, replacePlugin: true }); assert.equal(result.ok, true); assert.deepEqual(result.removed, ['lms-cli@personal']);
  assert(calls.findIndex(c => c[1] === 'remove') > calls.findIndex(c => c[1] === 'add'));
  const generated = JSON.parse(await readFile(join(home, 'codex-integration/plugins/lms-cli/.mcp.json'), 'utf8'));
  assert.equal(generated.mcpServers.lms.command, process.execPath); assert.equal(generated.mcpServers.lms.env.LMS_HOME, home);
  assert.equal(generated.mcpServers.lms.env.LMS_UPDATE_CHECK, '0');
});

test('managed MCP config follows the stable launcher and update refuses unmanaged directories', async () => {
  const old = process.env.LMS_INSTALL_ROOT;
  const root = join(home, 'runtime with spaces');
  process.env.LMS_INSTALL_ROOT = root;
  try {
    const cfg = mcpConfig().mcpServers.lms;
    assert.equal(cfg.args.at(-1), 'mcp'); assert(!JSON.stringify(cfg).includes('/versions/'));
    assert(JSON.stringify(cfg).includes(process.platform === 'win32' ? 'lms.ps1' : '/bin/lms'));
    await assert.rejects(installationRoot(), (e: any) => e.code === 'INSTALL_CONFLICT');
    await mkdir(root); await writeFile(join(root, '.lms-install'), 'lms-cli-managed-v1\n');
    assert.equal(await installationRoot(), root);
    await assert.rejects(rollback(), (e: any) => e.code === 'NO_PREVIOUS_VERSION');
    await writeFile(join(root, 'current'), 'v0.4.0\n'); await writeFile(join(root, 'previous'), '../../outside\n');
    await assert.rejects(rollback(), (e: any) => e.code === 'UPDATE_VERSION_INVALID');
    assert.equal(await readFile(join(root, 'current'), 'utf8'), 'v0.4.0\n');
  } finally { if (old === undefined) delete process.env.LMS_INSTALL_ROOT; else process.env.LMS_INSTALL_ROOT = old; }
});
