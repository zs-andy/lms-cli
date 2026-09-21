// Isolated acceptance: no real Codex configuration, credentials or school network calls.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { codexExecutable } from '../dist/src/codex.js';
import { safeArchiveEntry } from '../dist/src/upgrade.js';
import * as tar from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'lms-clean-install-'));
const installRoot = join(temp, 'runtime with spaces');
const state = join(temp, 'state');
const archive = join(root, 'release-cli', `lms-cli-${pkg.version}-${process.platform}-${process.arch}.tar.gz`);
let codex;
try { codex = codexExecutable(); } catch {}
try {
  // The exact published bundle must also pass the in-app updater's archive policy.
  await tar.t({ file: archive, strict: true, onReadEntry: entry => assert(safeArchiveEntry(entry.path, entry.type, entry.linkpath), `Unsafe bundle entry: ${entry.path}`) });
  const utilities = join(temp, 'system-tools'); await mkdir(utilities);
  if (process.platform !== 'win32') {
    for (const name of ['sh', 'uname', 'tar', 'gzip', 'shasum', 'sha256sum', 'awk', 'grep', 'sed', 'tr', 'mkdir', 'rmdir', 'mktemp', 'cat', 'cp', 'mv', 'rm', 'chmod', 'ln', 'readlink', 'dirname', 'date', 'git']) {
      const original = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map(p => join(p, name)).find(existsSync);
      if (original) await symlink(original, join(utilities, name));
    }
  }
  const env = { ...process.env, HOME: join(temp, 'user-home'), LMS_HOME: state, LMS_UPDATE_CHECK: '0', CODEX_HOME: join(temp, 'codex-home'), PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : utilities };
  if (process.platform === 'win32') env.USERPROFILE = env.HOME;
  delete env.LMS_INSTALL_ROOT; delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH; delete env.LMS_AUTH_APP;
  await mkdir(env.CODEX_HOME, { recursive: true });
  await mkdir(env.HOME, { recursive: true });
  assert(spawnSync('node', ['--version'], { env }).error, 'The acceptance environment must not expose system Node.');
  const run = (command, args, timeout = 120000) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout });
    if (result.status !== 0 && codex && args.includes('connect')) {
      const diagnostic = spawnSync(codex.command, [...codex.prefix, 'plugin', 'marketplace', 'add', join(state, 'codex-integration'), '--json'], { env, encoding: 'utf8', timeout: 30000 });
      console.error('Isolated client diagnostic:', diagnostic.stdout, diagnostic.stderr);
    }
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const installArgs = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'install.ps1'), '-Version', `v${pkg.version}`, '-InstallDir', installRoot, '-Archive', archive, '-ChecksumFile', `${archive}.sha256`, '-NoSetup', '-NoPath']
    : [join(root, 'install.sh'), '--version', `v${pkg.version}`, '--dir', installRoot, '--archive', archive, '--checksum-file', `${archive}.sha256`, '--no-setup', '--no-path'];
  run(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', installArgs);
  env.LMS_INSTALL_ROOT = installRoot;
  const command = process.platform === 'win32' ? 'powershell.exe' : join(installRoot, 'bin', 'lms');
  const prefix = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(installRoot, 'bin', 'lms.ps1')] : [];
  const cli = args => run(command, [...prefix, ...args]);
  const doctor = JSON.parse(cli(['doctor'])); assert.equal(doctor.version, pkg.version); assert.equal(doctor.nativeKeyringModuleLoads, true); assert.equal(doctor.authorizationRuntimeInstalled, true); assert.equal(doctor.installation, 'managed');
  const schools = JSON.parse(cli(['schools', 'search', '理大', '--offline']));
  assert.equal(schools.ok, true); assert(schools.matches.some(s => s.id === 'preset:polyu'));
  assert.equal(existsSync(join(state, 'profiles.json')), false, 'Search must not create a school configuration.');
  const setup = ['setup', '--preset', 'polyu', '--yes', '--no-login', '--no-codex'];
  assert.equal(JSON.parse(cli(setup)).ready, false);
  const before = await readFile(join(state, 'profiles.json'), 'utf8');
  await writeFile(join(state, 'synthetic.vault'), 'SYNTHETIC-NOT-A-CREDENTIAL');
  cli(setup); assert.equal(await readFile(join(state, 'profiles.json'), 'utf8'), before);
  const config = JSON.parse(cli(['mcp-config'])).mcpServers.lms;
  const client = new Client({ name: 'clean-install-acceptance', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ ...config, env: { ...env, ...config.env }, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 17); assert(tools.some(t => t.name === 'lms_update_check'));
    const search = await client.callTool({ name: 'lms_school_search', arguments: { query: '理大', offline: true } });
    assert.equal(search.isError, false); assert(JSON.parse(search.content[0].text).matches.length > 0);
    const result = await client.callTool({ name: 'lms_profiles', arguments: {} }); assert.equal(result.isError, false);
    const value = JSON.parse(result.content[0].text); assert.equal(value.profiles.length, 1); assert.equal(value.update.status, 'disabled');
  } finally { await client.close(); }
  const catalog = JSON.parse(cli(['tools'])); assert(catalog.length >= 50);
  if (codex && codex.prefix.length === 0) {
    env.LMS_CODEX_BIN = codex.command;
    const connected = JSON.parse(cli(['connect', 'codex', '--yes'])); assert.equal(connected.ok, true);
    const repeated = JSON.parse(cli(['connect', 'codex', '--yes'])); assert.equal(repeated.ok, true); assert.equal(repeated.version, connected.version);
    console.log('Isolated real Codex plugin registration and repeat installation passed.');
  } else console.log('Codex executable not available: real client registration not tested on this runner.');
  // An interrupted installer can leave an invalid next-version pointer. Rollback must restore the verified previous runtime.
  await writeFile(join(installRoot, 'previous'), `v${pkg.version}\n`);
  await writeFile(join(installRoot, 'current'), 'v99.0.0\n');
  const installed = join(installRoot, 'versions', `v${pkg.version}`);
  const rolledBack = JSON.parse(run(join(installed, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), [join(installed, 'app/bin/lms.js'), 'update', '--rollback', '--yes'], 120000));
  // Direct invocation needs the managed-root environment supplied by the stable launcher.
  assert.equal(rolledBack.ok, true);
  assert.equal(await readFile(join(state, 'profiles.json'), 'utf8'), before);
  assert.equal(await readFile(join(state, 'synthetic.vault'), 'utf8'), 'SYNTHETIC-NOT-A-CREDENTIAL');
  run(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', installArgs);
  // A damaged existing version must not be accepted just because the freshly downloaded copy works.
  const entry = join(installed, 'app', 'bin', 'lms.js');
  const original = await readFile(entry);
  const pointer = await readFile(join(installRoot, 'current'), 'utf8');
  try {
    await writeFile(entry, 'process.exit(2);\n');
    const damaged = spawnSync(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', installArgs, { env, encoding: 'utf8', timeout: 120000 });
    assert.notEqual(damaged.status, 0, 'Reinstallation must validate the existing version it will reuse.');
    assert.equal(await readFile(join(installRoot, 'current'), 'utf8'), pointer);
  } finally { await writeFile(entry, original); }
  assert.equal(JSON.parse(cli(['doctor'])).version, pkg.version);
  console.log('Clean CLI installation, native module loading, idempotent setup, MCP/connector discovery, rollback and reinstall passed without system Node or graphical windows.');
} finally { await rm(temp, { recursive: true, force: true }); }
