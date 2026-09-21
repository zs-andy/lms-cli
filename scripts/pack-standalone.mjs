// Build on the target OS/architecture. No user state, global Node or compiler is needed at install time.
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as tar from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'lms-bundle-'));
const output = join(root, 'release-cli');
const name = `lms-cli-${pkg.version}-${process.platform}-${process.arch}.tar.gz`;
try {
  await mkdir(join(stage, 'app'));
  for (const path of ['package.json', 'package-lock.json', 'bin', 'dist', 'plugins', 'docs', 'README.md', 'PRIVACY.md', 'SECURITY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, path), join(stage, 'app', path), { recursive: true });
  for (const platform of ['canvas', 'blackboard']) {
    await mkdir(join(stage, 'app', 'vendor', platform), { recursive: true });
    await cp(join(root, 'vendor', platform, 'LICENSE'), join(stage, 'app', 'vendor', platform, 'LICENSE'));
  }
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run through npm run pack:standalone so the npm executable is known.');
  const install = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(stage, 'app'), stdio: 'inherit', timeout: 300_000 });
  if (install.status !== 0) throw new Error('Production dependency installation failed.');
  // Electron 44 downloads lazily, not during npm ci. Make authorization truly self-contained.
  const electronRoot = join(stage, 'app', 'node_modules', 'electron');
  const localElectron = join(root, 'node_modules', 'electron');
  const expectedElectron = pkg.optionalDependencies.electron;
  let copiedElectron = false;
  try {
    const localVersion = (await readFile(join(localElectron, 'dist', 'version'), 'utf8')).trim().replace(/^v/, '');
    if (localVersion === expectedElectron) {
      await cp(join(localElectron, 'dist'), join(electronRoot, 'dist'), { recursive: true, verbatimSymlinks: true });
      await cp(join(localElectron, 'path.txt'), join(electronRoot, 'path.txt'));
      copiedElectron = true;
    }
  } catch {}
  if (!copiedElectron) {
    const clean = { ...process.env }; delete clean.ELECTRON_OVERRIDE_DIST_PATH; delete clean.ELECTRON_RUN_AS_NODE;
    const download = spawnSync(process.execPath, [join(electronRoot, 'install.js')], { env: clean, stdio: 'inherit', timeout: 300000 });
    if (download.status !== 0) throw new Error('Authorization runtime download failed; refusing to ship an incomplete bundle.');
  }
  const binary = join(electronRoot, 'dist', (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim());
  const architecture = spawnSync(binary, ['-p', 'process.arch'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 });
  if (architecture.status !== 0 || architecture.stdout.trim() !== process.arch) throw new Error('Bundled authorization runtime architecture mismatch.');
  await mkdir(join(stage, 'runtime'));
  // Do not copy a Homebrew/system Node: it may depend on libraries absent on the user's machine.
  const nodeVersion = process.env.LMS_BUILD_NODE_VERSION || process.versions.node;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 22) throw new Error('Unsupported bundled Node version.');
  const nodeBase = `https://nodejs.org/dist/v${nodeVersion}/`;
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Cannot download official Node: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = (await get(`${nodeBase}SHASUMS256.txt`)).toString('utf8');
  const nodeName = process.platform === 'win32' ? `node-v${nodeVersion}-win-${process.arch}.zip` : `node-v${nodeVersion}-${process.platform}-${process.arch}.tar.gz`;
  const expected = sums.split(/\r?\n/).find(line => line.slice(66) === nodeName)?.slice(0, 64);
  const nodeBytes = await get(`${nodeBase}${nodeName}`);
  if (!expected || createHash('sha256').update(nodeBytes).digest('hex') !== expected) throw new Error('Official Node checksum mismatch.');
  if (process.platform === 'win32') {
    // The verified official ZIP includes the matching license; /dist/v*/LICENSE does not.
    const archive = join(stage, 'node.zip'); await writeFile(archive, nodeBytes);
    const prefix = nodeName.replace(/\.zip$/, '');
    const extract = spawnSync('tar.exe', ['-xf', archive, '--strip-components', '1', '-C', join(stage, 'runtime'), `${prefix}/node.exe`, `${prefix}/LICENSE`], { stdio: 'inherit', timeout: 120000 });
    if (extract.status !== 0) throw new Error('Official Windows Node runtime extraction failed.');
  } else {
    const archive = join(stage, 'node.tar.gz'); await writeFile(archive, nodeBytes);
    const prefix = nodeName.replace(/\.tar\.gz$/, '');
    await tar.x({ file: archive, cwd: join(stage, 'runtime'), strip: 1, filter: path => [prefix, `${prefix}/`, `${prefix}/bin/`, `${prefix}/bin/node`, `${prefix}/LICENSE`].includes(path) });
    await rename(join(stage, 'runtime', 'bin', 'node'), join(stage, 'runtime', 'node'));
  }
  await cp(join(root, 'scripts', 'launchers'), join(stage, 'launchers'), { recursive: true });
  await chmod(join(stage, 'launchers', 'lms'), 0o755);
  await writeFile(join(stage, 'bundle.json'), JSON.stringify({ schema: 1, version: pkg.version, platform: process.platform, arch: process.arch, node: nodeVersion }, null, 2));
  await mkdir(output, { recursive: true });
  // Preserve Electron framework symlinks/signatures. npm's CLI shims are unused and need not ship.
  await tar.c({ file: join(output, name), cwd: stage, gzip: true, portable: true, follow: false, noMtime: true, filter: path => !path.split('/').includes('.bin') }, ['runtime', 'app', 'launchers', 'bundle.json']);
  const digest = createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  await writeFile(join(output, `${name}.sha256`), `${digest}  ${name}\n`);
  console.log(`Built ${name} (${digest}). Combine per-artifact .sha256 files into SHA256SUMS.txt when publishing.`);
} finally { await rm(stage, { recursive: true, force: true }); }
