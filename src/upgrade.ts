import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, posix, resolve, parse } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import lockfile from 'proper-lockfile';
import * as tar from 'tar';
import { atomicWrite, stateHome } from './config.js';
import { LmsError } from './errors.js';
import { managedRoot } from './runtime.js';
import { parseVersion, RELEASES_URL, type UpdateInfo } from './updates.js';

export const INSTALL_MARKER = 'lms-cli-managed-v1\n';
export function safeTag(value: string) { return /^v\d+\.\d+\.\d+$/.test(value) && Boolean(parseVersion(value)); }

export async function installationRoot(root = managedRoot()) {
  if (!root || resolve(root) === parse(resolve(root)).root || resolve(root) === homedir()) throw new LmsError('UNMANAGED_INSTALL', '当前不是一条命令安装的托管 CLI，不能安全地自动覆盖。', `请按 README 的安装命令安装自包含 CLI，或从 ${RELEASES_URL} 下载；原有学校数据会保留。`);
  try { if (await readFile(join(root, '.lms-install'), 'utf8') !== INSTALL_MARKER) throw new Error(); }
  catch { throw new LmsError('INSTALL_CONFLICT', '安装目录标记缺失或不匹配，没有覆盖任何文件。'); }
  return root;
}

export function expectedChecksum(text: string, filename: string) {
  const found = text.split(/\r?\n/).flatMap(line => {
    const m = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
    return m && m[2] === filename ? [m[1]!.toLowerCase()] : [];
  });
  if (found.length !== 1) throw new LmsError('CHECKSUM_INVALID', '发布校验和缺失或重复，已停止升级。');
  return found[0]!;
}

export function safeArchiveEntry(path: string, type: string, linkpath = '') {
  const safe = (value: string) => !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').includes('..');
  if (!safe(path) || !['app', 'runtime', 'launchers', 'bundle.json'].includes(path.split('/')[0]!)) return false;
  if (['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(type)) return true;
  if (type !== 'SymbolicLink' && type !== 'Link') return false;
  if (!linkpath || linkpath.startsWith('/') || linkpath.includes('\\') || /^[A-Za-z]:/.test(linkpath)) return false;
  const target = posix.normalize(type === 'SymbolicLink' ? posix.join(posix.dirname(path), linkpath) : linkpath);
  return safe(target) && ['app', 'runtime', 'launchers'].includes(target.split('/')[0]!);
}

async function download(url: string, file: string, maxBytes: number): Promise<string> {
  let target = new URL(url);
  if (target.origin !== 'https://github.com' || !target.pathname.startsWith('/zs-andy/lms-cli/releases/download/')) throw new LmsError('UPDATE_URL_INVALID', '更新下载地址不属于本项目，已拒绝。');
  const signal = AbortSignal.timeout(180_000);
  for (let n = 0; n < 5; n++) {
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new LmsError('UPDATE_URL_INVALID', '下载重定向不属于 GitHub 发布服务。');
    const res = await fetch(target, { redirect: 'manual', signal, headers: { 'User-Agent': 'lms-cli-updater' } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location'); await res.body?.cancel();
      if (!location) throw new Error('Missing redirect'); target = new URL(location, target); continue;
    }
    if (!res.ok || !res.body || Number(res.headers.get('content-length') || 0) > maxBytes) { await res.body?.cancel(); throw new LmsError('UPDATE_DOWNLOAD_FAILED', '更新下载失败或文件过大；当前版本保持不变。'); }
    const hash = createHash('sha256'); let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, cb) { size += chunk.length; if (size > maxBytes) cb(new Error('Download too large')); else { hash.update(chunk); cb(null, chunk); } } });
    await pipeline(Readable.fromWeb(res.body as any), limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return hash.digest('hex');
  }
  throw new LmsError('UPDATE_DOWNLOAD_FAILED', '更新下载重定向过多；当前版本保持不变。');
}

async function verifyBundle(directory: string, tag: string) {
  const bundle = JSON.parse(await readFile(join(directory, 'bundle.json'), 'utf8'));
  if (bundle.schema !== 1 || bundle.version !== tag.slice(1) || bundle.platform !== process.platform || bundle.arch !== process.arch) throw new LmsError('UPDATE_INCOMPATIBLE', '安装包版本、系统或架构不匹配，没有激活。');
  await access(join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  await access(join(directory, 'app', 'bin', 'lms.js'));
}

async function runBundle(directory: string, args: string[], env: NodeJS.ProcessEnv, expectedVersion?: string) {
  return new Promise<void>((accept, reject) => {
    const child = spawn(join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), [join(directory, 'app', 'bin', 'lms.js'), ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const timer = setTimeout(() => child.kill(), 35_000);
    child.stdout.on('data', b => { out += b.toString(); if (out.length > 1024 * 1024) child.kill(); }); child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new LmsError('UPDATE_VERIFY_FAILED', '新版本无法运行；请保留当前版本。')); });
    child.once('close', code => {
      clearTimeout(timer);
      try { const result = JSON.parse(out); if (code !== 0 || result.ok === false || (args[0] === 'doctor' && (!result.nativeKeyringModuleLoads || !result.authorizationRuntimeInstalled || result.version !== expectedVersion))) throw new Error(); accept(); }
      catch { reject(new LmsError('UPDATE_VERIFY_FAILED', '新版本运行检查失败。')); }
    });
  });
}

async function activate(root: string, tag: string) {
  if (!safeTag(tag)) throw new LmsError('UPDATE_VERSION_INVALID', '无效的安装版本标识。');
  const directory = join(root, 'versions', tag);
  await verifyBundle(directory, tag);
  const checkHome = await mkdtemp(join(tmpdir(), 'lms-upgrade-check-'));
  try { await runBundle(directory, ['doctor'], { ...process.env, LMS_HOME: checkHome, LMS_UPDATE_CHECK: '0' }, tag.slice(1)); }
  finally { await rm(checkHome, { recursive: true, force: true }); }
  const previous = (await readFile(join(root, 'current'), 'utf8')).trim();
  if (!safeTag(previous)) throw new LmsError('INSTALL_CONFLICT', '当前安装指针无效，未修改。');
  if (previous !== tag) {
    await atomicWrite(join(root, 'previous'), `${previous}\n`);
    await atomicWrite(join(root, 'current'), `${tag}\n`);
  }
  let integration: 'not-configured' | 'refreshed' | 'retry-needed' = 'not-configured';
  try {
    await access(join(stateHome(), 'codex-integration', '.lms-managed'));
    try { await runBundle(directory, ['connect', 'codex', '--yes'], { ...process.env, LMS_INSTALL_ROOT: root, LMS_UPDATE_CHECK: '0' }); integration = 'refreshed'; }
    catch { integration = 'retry-needed'; }
  } catch {}
  return { ok: true, version: tag.slice(1), previous: previous.slice(1), integration, note: integration === 'retry-needed' ? 'CLI 已升级，学校数据保留。Codex 插件刷新未完成，请运行 lms connect codex 后新建任务。' : '版本已切换，学校配置、凭据和待办均保留。已有进程继续使用旧版；重新运行 CLI / 新建 Codex 任务使用新版。', rollback: 'lms update --rollback' };
}

export async function upgrade(info: UpdateInfo) {
  const root = await installationRoot();
  if (info.status !== 'available' || !info.latest || !info.asset || !info.checksumUrl || !safeTag(`v${info.latest}`)) throw new LmsError('UPDATE_NOT_INSTALLABLE', '没有可自动安装的匹配版本，请查看发布页面。', info.releaseUrl);
  const tag = `v${info.latest}`;
  // Reconstruct, never execute or follow arbitrary URLs supplied in release notes/tool content.
  const base = `${RELEASES_URL}/download/${tag}/`;
  if (info.asset.url !== `${base}${info.asset.name}` || info.checksumUrl !== `${base}SHA256SUMS.txt` || !/^[a-zA-Z0-9.-]+$/.test(info.asset.name)) throw new LmsError('UPDATE_URL_INVALID', '更新地址校验失败。');
  const release = await lockfile.lock(root, { stale: 300_000, retries: 0 }).catch(() => { throw new LmsError('UPDATE_BUSY', '另一个安装或升级正在进行，请稍后再试。'); });
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(root, '.update-'));
    const sums = join(stage, 'SHA256SUMS.txt');
    await download(info.checksumUrl, sums, 1024 * 1024);
    const expected = expectedChecksum(await readFile(sums, 'utf8'), info.asset.name);
    const archive = join(stage, 'package.tar.gz');
    const actual = await download(info.asset.url, archive, 768 * 1024 * 1024);
    if (actual !== expected) throw new LmsError('CHECKSUM_MISMATCH', '更新包 SHA-256 不匹配，当前版本保持不变。');
    let invalid = false, unpacked = 0, count = 0;
    await tar.t({ file: archive, strict: true, onReadEntry: entry => {
      count++; unpacked += entry.size;
      if (!safeArchiveEntry(entry.path, entry.type, entry.linkpath) || unpacked > 3 * 1024 ** 3 || count > 100000) invalid = true;
    } });
    if (invalid) throw new LmsError('UPDATE_ARCHIVE_INVALID', '安装包含不安全路径或超出解压上限，未激活。');
    const unpack = join(stage, 'unpack'); await mkdir(unpack);
    await tar.x({ file: archive, cwd: unpack, strict: true, preservePaths: false });
    await verifyBundle(unpack, tag);
    await mkdir(join(root, 'versions'), { recursive: true });
    const destination = join(root, 'versions', tag);
    try { await access(destination); await verifyBundle(destination, tag); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rename(unpack, destination);
    }
    return await activate(root, tag);
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); await release(); }
}

export async function rollback() {
  const root = await installationRoot();
  const release = await lockfile.lock(root, { stale: 300_000, retries: 0 }).catch(() => { throw new LmsError('UPDATE_BUSY', '另一个安装或升级正在进行，请稍后再试。'); });
  try {
    let tag: string;
    try { tag = (await readFile(join(root, 'previous'), 'utf8')).trim(); }
    catch { throw new LmsError('NO_PREVIOUS_VERSION', '没有可回退的上一版本。'); }
    return await activate(root, tag);
  } finally { await release(); }
}
