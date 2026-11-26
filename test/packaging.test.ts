import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  installManager,
  installationKind,
  managedRoot,
  mcpConfig,
  PACKAGE_MANAGER_UPGRADE_COMMANDS,
  parseInstallManager,
} from '../src/runtime.js';
import { installationRoot, rollback } from '../src/upgrade.js';
import {
  generatePackageManifests,
  parseChecksums,
  renderHomebrewFormula,
  renderScoopManifest,
  renderWingetManifests,
} from '../scripts/generate-package-manifests.mjs';

const sampleChecksumsText = [
  `${'a'.repeat(64)}  lms-cli-0.5.0-darwin-arm64.tar.gz`,
  `${'b'.repeat(64)}  lms-cli-0.5.0-darwin-x64.tar.gz`,
  `${'c'.repeat(64)}  lms-cli-0.5.0-linux-arm64.tar.gz`,
  `${'d'.repeat(64)}  lms-cli-0.5.0-linux-x64.tar.gz`,
  `${'e'.repeat(64)}  lms-cli-0.5.0-win32-x64.tar.gz`,
  `${'f'.repeat(64)}  lms-cli-0.5.0-win32-arm64.tar.gz`,
  `${'1'.repeat(64)}  lms-cli-0.5.0-x64.exe`,
  `${'2'.repeat(64)}  lms-cli-0.5.0-arm64.exe`,
].join('\n');

test('detects Homebrew, Scoop, and Winget installs from env vars and standard installation paths', () => {
  assert.equal(parseInstallManager('homebrew'), 'homebrew');
  assert.equal(parseInstallManager('BREW'), 'homebrew');
  assert.equal(parseInstallManager('scoop'), 'scoop');
  assert.equal(parseInstallManager('winget'), 'winget');
  assert.equal(parseInstallManager('unknown'), undefined);

  assert.equal(installManager({ LMS_INSTALL_MANAGER: 'homebrew' }, '/tmp/any/runtime.js'), 'homebrew');
  assert.equal(installManager({}, '/opt/homebrew/Cellar/lms-cli/0.5.0/libexec/app/dist/src/runtime.js'), 'homebrew');
  assert.equal(installManager({}, '/usr/local/Cellar/lms-cli/0.5.0/libexec/app/dist/src/runtime.js'), 'homebrew');
  assert.equal(installManager({}, 'C:\\Users\\alice\\scoop\\apps\\lms-cli\\current\\app\\dist\\src\\runtime.js'), 'scoop');
  assert.equal(installManager({}, 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WinGet\\Packages\\zs-andy.lms-cli_abc\\runtime.js'), 'winget');
  assert.equal(installManager({}, '/Users/alice/projects/lms-cli/dist/src/runtime.js'), undefined);

  assert.equal(installationKind({ LMS_INSTALL_MANAGER: 'scoop', LMS_INSTALL_ROOT: '/tmp/root' }, '/tmp/r.js'), 'scoop');
  assert.equal(managedRoot({ LMS_INSTALL_MANAGER: 'homebrew', LMS_INSTALL_ROOT: '/tmp/root' }, '/tmp/r.js'), undefined);
  assert.equal(installationKind({ LMS_INSTALL_ROOT: '/tmp/root' }, '/tmp/r.js'), 'managed');
  assert.equal(installationKind({}, '/tmp/r.js'), 'npm-or-source');
});

test('mcpConfig prefers stable LMS_INSTALL_LAUNCHER for package-manager installs', () => {
  const prevLauncher = process.env.LMS_INSTALL_LAUNCHER;
  const prevManager = process.env.LMS_INSTALL_MANAGER;
  try {
    process.env.LMS_INSTALL_MANAGER = 'homebrew';
    process.env.LMS_INSTALL_LAUNCHER = '/opt/homebrew/opt/lms-cli/bin/lms';
    const cfg = mcpConfig().mcpServers.lms;
    assert.equal(cfg.command, '/opt/homebrew/opt/lms-cli/bin/lms');
    assert.deepEqual(cfg.args, ['mcp']);
  } finally {
    if (prevLauncher === undefined) delete process.env.LMS_INSTALL_LAUNCHER;
    else process.env.LMS_INSTALL_LAUNCHER = prevLauncher;
    if (prevManager === undefined) delete process.env.LMS_INSTALL_MANAGER;
    else process.env.LMS_INSTALL_MANAGER = prevManager;
  }
});

test('installationRoot and rollback fail closed for package-manager-managed installs', async () => {
  const prevManager = process.env.LMS_INSTALL_MANAGER;
  try {
    process.env.LMS_INSTALL_MANAGER = 'homebrew';
    await assert.rejects(installationRoot('/tmp/ignored'), (e: any) => e.code === 'PACKAGE_MANAGER_INSTALL' && e.hint === PACKAGE_MANAGER_UPGRADE_COMMANDS.homebrew);
    process.env.LMS_INSTALL_MANAGER = 'scoop';
    await assert.rejects(rollback(), (e: any) => e.code === 'PACKAGE_MANAGER_INSTALL' && e.hint === PACKAGE_MANAGER_UPGRADE_COMMANDS.scoop);
  } finally {
    if (prevManager === undefined) delete process.env.LMS_INSTALL_MANAGER;
    else process.env.LMS_INSTALL_MANAGER = prevManager;
  }
});

test('CLI doctor and update report package-manager installs cleanly and refuse self-overwrite', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lms-pkg-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));

  const doctor = spawnSync(process.execPath, [cli, 'doctor'], {
    env: { ...process.env, LMS_HOME: home, LMS_UPDATE_CHECK: '0', LMS_INSTALL_MANAGER: 'homebrew' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = JSON.parse(doctor.stdout);
  assert.equal(doctorJson.installation, 'homebrew');
  assert.equal(doctorJson.upgradeCommand, 'brew upgrade lms-cli');

  const rollbackCmd = spawnSync(process.execPath, [cli, 'update', '--rollback', '--yes'], {
    env: { ...process.env, LMS_HOME: home, LMS_UPDATE_CHECK: '0', LMS_INSTALL_MANAGER: 'scoop' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(rollbackCmd.status, 1);
  const rollbackJson = JSON.parse(rollbackCmd.stdout);
  assert.equal(rollbackJson.error.code, 'PACKAGE_MANAGER_INSTALL');
  assert.equal(rollbackJson.error.hint, 'scoop update lms-cli');
});

test('manifest generator outputs deterministic Homebrew, Scoop, and Winget manifests from SHA256SUMS.txt', async t => {
  const checksums = parseChecksums(sampleChecksumsText);
  assert.equal(checksums.size, 8);

  const formula = renderHomebrewFormula({ version: '0.5.0', checksums });
  assert(formula);
  assert.match(formula, /class LmsCli < Formula/);
  assert.match(formula, /version "0\.5\.0"/);
  assert.match(formula, /lms-cli-0\.5\.0-darwin-arm64\.tar\.gz/);
  assert.match(formula, /lms-cli-0\.5\.0-linux-x64\.tar\.gz/);
  assert.match(formula, new RegExp(`sha256 "${'a'.repeat(64)}"`));
  assert.match(formula, /LMS_INSTALL_MANAGER="homebrew"/);
  assert.match(formula, /LMS_INSTALL_LAUNCHER="#\{opt_bin\}\/lms"/);

  const scoopRaw = renderScoopManifest({ version: '0.5.0', checksums });
  assert(scoopRaw);
  const scoop = JSON.parse(scoopRaw);
  assert.equal(scoop.version, '0.5.0');
  assert.equal(scoop.license, 'MIT');
  assert.equal(scoop.architecture['64bit'].hash, 'e'.repeat(64));
  assert.equal(scoop.architecture.arm64.hash, 'f'.repeat(64));
  assert.equal(scoop.bin, 'lms.cmd');
  assert.match(scoop.installer.script.join('\n'), /LMS_INSTALL_MANAGER=scoop/);

  const winget = renderWingetManifests({ version: '0.5.0', checksums });
  assert(winget);
  assert.deepEqual(Object.keys(winget).sort(), [
    'zs-andy.lms-cli.installer.yaml',
    'zs-andy.lms-cli.locale.en-US.yaml',
    'zs-andy.lms-cli.yaml',
  ]);
  assert.match(winget['zs-andy.lms-cli.installer.yaml']!, /InstallerType: nullsoft/);
  assert.match(winget['zs-andy.lms-cli.installer.yaml']!, new RegExp(`InstallerSha256: ${'1'.repeat(64)}`));
  assert.match(winget['zs-andy.lms-cli.installer.yaml']!, new RegExp(`InstallerSha256: ${'2'.repeat(64)}`));

  const outDir = await mkdtemp(join(tmpdir(), 'lms-manifests-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const checksumFile = join(outDir, 'SHA256SUMS.txt');
  await writeFile(checksumFile, sampleChecksumsText, 'utf8');
  const targetDir = join(outDir, 'generated');
  const script = fileURLToPath(new URL('../scripts/generate-package-manifests.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script, '--version', '0.5.0', '--checksums', checksumFile, '--out', targetDir], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(await readFile(join(targetDir, 'homebrew/Formula/lms-cli.rb'), 'utf8'), formula);
  assert.equal(await readFile(join(targetDir, 'scoop/bucket/lms-cli.json'), 'utf8'), scoopRaw);
  assert.equal(
    await readFile(join(targetDir, 'winget/manifests/z/zs-andy/lms-cli/0.5.0/zs-andy.lms-cli.yaml'), 'utf8'),
    winget['zs-andy.lms-cli.yaml'],
  );
});

test('manifest generator rejects invalid versions, duplicate/malformed checksums, and empty asset sets', async t => {
  const outDir = await mkdtemp(join(tmpdir(), 'lms-manifests-err-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));

  assert.throws(() => parseChecksums('not-a-checksum  file.tar.gz'), /Invalid checksum line/);
  assert.throws(() => parseChecksums(`${'a'.repeat(64)}  dup.tar.gz\n${'b'.repeat(64)}  dup.tar.gz`), /Duplicate checksum/);
  await assert.rejects(
    generatePackageManifests({ version: '0.5.0-beta.1', checksumsText: sampleChecksumsText, outDir }),
    /Invalid stable release version/,
  );
  await assert.rejects(
    generatePackageManifests({ version: '0.5.0', checksumsText: `${'a'.repeat(64)}  unrelated.zip\n`, outDir }),
    /No matching standalone CLI/,
  );
});
