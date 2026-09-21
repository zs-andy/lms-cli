import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite, locked, stateHome } from './config.js';
import { LmsError } from './errors.js';
import { mcpConfig } from './runtime.js';
import { VERSION } from './version.js';

export const LOCAL_MARKETPLACE = 'lms-cli-local';
export const LOCAL_PLUGIN = `lms-cli@${LOCAL_MARKETPLACE}`;
export type Executable = { command: string; prefix: string[] };
export type CodexRunner = (args: string[]) => Promise<any>;

export function codexExecutable(): Executable {
  if (process.env.LMS_CODEX_BIN) {
    const value = process.env.LMS_CODEX_BIN;
    if (!isAbsolute(value) || !existsSync(value) || /\.(cmd|bat)$/i.test(value)) throw new LmsError('CODEX_UNAVAILABLE', 'LMS_CODEX_BIN 必须指向真实 Codex 可执行文件的绝对路径，不是 .cmd 或 shell 命令。');
    return { command: value, prefix: [] };
  }
  const appCandidates = process.platform === 'darwin' ? [
    '/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'), join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
  ] : [];
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir));
  const candidates = [...appCandidates, ...pathDirs.map(dir => join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'))];
  const command = candidates.find(existsSync);
  if (command) return { command, prefix: [] };
  // npm's Windows .cmd shim cannot be spawned safely without a shell. Invoke its JS entry with our own Node.
  for (const dir of pathDirs) {
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return { command: process.execPath, prefix: [script] };
  }
  throw new LmsError('CODEX_UNAVAILABLE', '未找到可运行的 Codex。学校配置已保留。', '安装并登录 Codex，或通过 LMS_CODEX_BIN 指定其可执行文件，然后重跑 lms setup。只用 CLI 可加 --no-codex。');
}

export function makeCodexRunner(executable = codexExecutable()): CodexRunner {
  return args => new Promise((resolve, reject) => {
    const child = spawn(executable.command, [...executable.prefix, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', exceeded = false;
    const timer = setTimeout(() => { child.kill(); }, 30_000);
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 1024 * 1024) { exceeded = true; child.kill(); } });
    child.stderr.on('data', () => {}); // Never expose arbitrary client diagnostics/config contents.
    child.once('error', () => { clearTimeout(timer); reject(new LmsError('CODEX_UNAVAILABLE', '无法启动 Codex，请检查安装或 LMS_CODEX_BIN。')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) return reject(new LmsError('CODEX_CONNECT_FAILED', 'Codex 插件操作未完成。已有学校数据没有删除。', '请更新 Codex 后重跑 lms setup；本项目要求 codex plugin 命令支持本地市场。'));
      try { resolve(JSON.parse(output)); } catch { reject(new LmsError('CODEX_PROTOCOL', 'Codex 未返回支持的 JSON 格式，请更新 Codex 后重试。')); }
    });
  });
}

export async function connectCodex(options: { replacePlugin?: boolean; runner?: CodexRunner } = {}) {
  const run = options.runner ?? makeCodexRunner();
  const list = await run(['plugin', 'list', '--json']);
  if (!Array.isArray(list.installed)) throw new LmsError('CODEX_PROTOCOL', '无法确定已安装插件，已停止以避免重复安装。');
  const conflicts = list.installed.filter((p: any) => p.name === 'lms-cli' && p.enabled !== false && p.pluginId !== LOCAL_PLUGIN);
  if (conflicts.length && !options.replacePlugin) throw new LmsError('PLUGIN_CONFLICT', `发现旧的 lms-cli 插件：${conflicts.map((p: any) => p.pluginId).join(', ')}。`, '确认替换这些同名插件后运行 lms setup --replace-plugin；学校配置和凭据不会删除。其他插件不受影响。');
  if (conflicts.some((p: any) => typeof p.pluginId !== 'string' || !/^lms-cli@[a-z0-9-]+$/.test(p.pluginId))) throw new LmsError('PLUGIN_CONFLICT', '旧插件标识无法安全识别，请在 Codex 中手动处理。');

  return locked(async () => {
    const root = join(stateHome(), 'codex-integration');
    const marker = join(root, '.lms-managed');
    if (existsSync(root) && (!existsSync(marker) || await readFile(marker, 'utf8') !== 'lms-cli\n')) throw new LmsError('INSTALL_CONFLICT', 'Codex 接入目录不是本工具管理的目录，没有覆盖其中内容。');
    const source = fileURLToPath(new URL('../../plugins/lms-cli/', import.meta.url));
    const stage = await mkdtemp(join(stateHome(), 'codex-stage-'));
    let staged = true;
    try {
      const plugin = join(stage, 'plugins', 'lms-cli');
      await cp(source, plugin, { recursive: true });
      const config = mcpConfig();
      const manifestFile = join(plugin, '.codex-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      const skill = await readFile(join(plugin, 'skills', 'lms-query', 'SKILL.md'), 'utf8');
      const hash = createHash('sha256').update(JSON.stringify([VERSION, config, manifest, skill])).digest('hex').slice(0, 16);
      manifest.version = `${VERSION.split('+')[0]}+codex.${hash}`;
      await atomicWrite(manifestFile, JSON.stringify(manifest, null, 2));
      await atomicWrite(join(plugin, '.mcp.json'), JSON.stringify(config, null, 2));
      await mkdir(join(stage, '.agents', 'plugins'), { recursive: true });
      // A dedicated generated marketplace avoids editing the user's personal marketplace or TOML.
      await atomicWrite(join(stage, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: LOCAL_MARKETPLACE, interface: { displayName: 'lms-cli · 本机安装' }, plugins: [{ name: 'lms-cli', source: { source: 'local', path: './plugins/lms-cli' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2));
      await atomicWrite(join(stage, '.lms-managed'), 'lms-cli\n');
      const backup = `${root}.previous-${randomUUID()}`;
      if (existsSync(root)) await rename(root, backup);
      try { await rename(stage, root); staged = false; }
      catch (error) { if (existsSync(backup)) await rename(backup, root); throw error; }
      // The previous generated configuration is kept for recovery; never touch unrelated plugins.
      await run(['plugin', 'marketplace', 'add', root, '--json']);
      await run(['plugin', 'add', LOCAL_PLUGIN, '--json']);
      const verified = await run(['plugin', 'list', '--json']);
      if (!verified.installed?.some((p: any) => p.pluginId === LOCAL_PLUGIN && p.enabled !== false && p.version === manifest.version)) throw new LmsError('CODEX_CONNECT_FAILED', '未能验证新版插件已启用；请重跑 lms setup。旧插件尚未移除。');
      for (const old of conflicts) await run(['plugin', 'remove', old.pluginId, '--json']);
      return { ok: true, plugin: LOCAL_PLUGIN, version: manifest.version, removed: conflicts.map((p: any) => p.pluginId), note: '已连接。请新建一个 Codex 任务使用 lms-cli；无需修改 PATH 或复制 MCP 配置。' };
    } finally { if (staged) await rm(stage, { recursive: true, force: true }); }
  });
}
