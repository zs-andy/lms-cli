import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { INSTALL_MARKER, upgrade, rollback } from '../src/upgrade.js';
import { inspectRelease, portableAsset, RELEASES_URL } from '../src/updates.js';

const version = '9.0.0';
const filename = portableAsset(version)!;
const base = `${RELEASES_URL}/download/v${version}/`;
const release = {
  tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [filename, 'SHA256SUMS.txt'].map(name => ({ name, state: 'uploaded', browser_download_url: `${base}${name}` })),
};
const info = inspectRelease(release);

async function bundle(directory: string, version: string) {
  await mkdir(join(directory, 'runtime'), { recursive: true });
  await mkdir(join(directory, 'app', 'bin'), { recursive: true });
  await writeFile(join(directory, 'bundle.json'), JSON.stringify({ schema: 1, version, platform: process.platform, arch: process.arch }));
  const executable = join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await copyFile(process.execPath, executable);
  else {
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\"'\"'")}' "$@"\n`);
    await chmod(executable, 0o755);
  }
  // Real child process: exercise the updater's verification and pointer transaction, without school data.
  await writeFile(join(directory, 'app', 'bin', 'lms.js'), `
    const fs = require('node:fs'), path = require('node:path');
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../bundle.json'), 'utf8'));
    if (process.env.LMS_TEST_UPDATE_VERIFY_FAIL === '1') process.exit(2);
    console.log(JSON.stringify({ ok: true, version, nativeKeyringModuleLoads: true, authorizationRuntimeInstalled: true }));
  `);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lms-upgrade-transaction-'));
  const root = join(directory, 'install with spaces'), state = join(directory, 'school-state');
  const keys = ['LMS_INSTALL_ROOT', 'LMS_HOME', 'LMS_TEST_UPDATE_VERIFY_FAIL'];
  const previousEnv = keys.map(key => process.env[key]);
  t.after(async () => {
    keys.forEach((key, index) => { if (previousEnv[index] === undefined) delete process.env[key]; else process.env[key] = previousEnv[index]; });
    await rm(directory, { recursive: true, force: true });
  });
  process.env.LMS_INSTALL_ROOT = root; process.env.LMS_HOME = state; delete process.env.LMS_TEST_UPDATE_VERIFY_FAIL;
  await mkdir(state); await bundle(join(root, 'versions', 'v1.0.0'), '1.0.0');
  await writeFile(join(root, '.lms-install'), INSTALL_MARKER);
  await writeFile(join(root, 'current'), 'v1.0.0\n');
  await writeFile(join(state, 'synthetic.vault'), 'SYNTHETIC-STATE-UNCHANGED');
  const next = join(directory, 'next'); await bundle(next, version);
  const archive = join(directory, 'package.tar.gz');
  await tar.c({ file: archive, cwd: next, gzip: true }, ['runtime', 'app', 'bundle.json']);
  const bytes = await readFile(archive), hash = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  const downloads = (badHash = false) => t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { 'User-Agent': 'lms-cli-updater' });
    if (String(url) === `${base}SHA256SUMS.txt`) return new Response(`${badHash ? '0'.repeat(64) : hash}  ${filename}\n`);
    assert.equal(String(url), `${base}${filename}`);
    return new Response(new Uint8Array(bytes));
  });
  const assertClean = async (current = 'v1.0.0') => {
    assert.equal(await readFile(join(root, 'current'), 'utf8'), `${current}\n`);
    assert.equal(await readFile(join(state, 'synthetic.vault'), 'utf8'), 'SYNTHETIC-STATE-UNCHANGED');
    assert(!(await readdir(root)).some(name => name.startsWith('.update-')));
    await assert.rejects(readFile(`${root}.lock`), { code: 'ENOENT' });
  };
  return { root, downloads, assertClean, calls: () => calls };
}

test('verified update activates only after runtime validation and rollback preserves school state', async t => {
  const f = await fixture(t); f.downloads();
  const updated = await upgrade(info);
  assert.equal(updated.version, version); assert.equal(updated.previous, '1.0.0');
  assert.equal(updated.integration, 'not-configured');
  await f.assertClean(`v${version}`);
  assert.equal(await readFile(join(f.root, 'previous'), 'utf8'), 'v1.0.0\n');
  const restored = await rollback(); assert.equal(restored.version, '1.0.0');
  await f.assertClean(); assert.equal(f.calls(), 2);
});

test('checksum mismatch leaves the installed version and data unchanged', async t => {
  const f = await fixture(t); f.downloads(true);
  await assert.rejects(upgrade(info), { code: 'CHECKSUM_MISMATCH' });
  await f.assertClean(); assert.equal(f.calls(), 2);
  assert.deepEqual(await readdir(join(f.root, 'versions')), ['v1.0.0']);
});

test('failed new-runtime validation leaves the current pointer intact and can be retried', async t => {
  const f = await fixture(t); f.downloads(); process.env.LMS_TEST_UPDATE_VERIFY_FAIL = '1';
  await assert.rejects(upgrade(info), { code: 'UPDATE_VERIFY_FAILED' });
  await f.assertClean(); await assert.rejects(readFile(join(f.root, 'previous')), { code: 'ENOENT' });
  delete process.env.LMS_TEST_UPDATE_VERIFY_FAIL;
  await upgrade(info); await f.assertClean(`v${version}`);
});

test('untrusted download redirects are rejected without contacting their destination', async t => {
  const f = await fixture(t);
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example/update' } }));
  await assert.rejects(upgrade(info), { code: 'UPDATE_URL_INVALID' });
  assert.equal(mock.mock.callCount(), 1); await f.assertClean();
});

test('explicit CLI install requests fail when no managed runtime or matching asset is available', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));
  const run = (payload: unknown, managed: boolean, args = ['update', '--yes']) => spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(payload))});`)}`,
    cli, ...args,
  ], { env: { ...process.env, LMS_INSTALL_ROOT: managed ? f.root : '', LMS_UPDATE_CHECK: '0' }, encoding: 'utf8', timeout: 20000 });
  for (const [payload, managed] of [[release, false], [{ ...release, assets: [] }, true]] as const) {
    const result = run(payload, managed);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'UPDATE_NOT_INSTALLABLE');
  }
  const checked = run(release, false, ['update', '--check']);
  assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).status, 'available');
  await f.assertClean();
});
