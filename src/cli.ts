#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { addProfile, getProfile, initProfile, loadConfig, Platform, platforms, presets, stateHome, useProfile } from './config.js';
import { VERSION } from './version.js';
import { withBackend } from './backend.js';
import { publicError, LmsError } from './errors.js';
import { platformFor } from './policy.js';
import { authStatus, startLogin, finishLogin } from './auth/launch.js';
import { vault } from './vault.js';
import { validateInWorker } from './auth/validate.js';
import { exportCalendar, listItems, upsertItems } from './items.js';
import { ask } from './ask.js';
import { getPlatform, platformDefinitions, platformIds } from './platforms/registry.js';
import { setup, diagnostics } from './setup.js';
import { connectCodex } from './codex.js';
import { mcpConfig, managedRoot } from './runtime.js';
import { checkForUpdates, type UpdateInfo } from './updates.js';
import { confirm, interactive } from './terminal.js';
import { searchSchools } from './schools.js';

const program = new Command().name('lms').description('lms-cli · multi-school Canvas / Blackboard CLI and Agent tools').version(VERSION).option('-p, --profile <id>', 'School/account profile (defaults to the active profile)').option('--json', 'Explicit machine-readable JSON output (default for structured commands)');
const profileId = () => program.opts().profile as string | undefined;
const out = (value: any) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); if (value?.ok === false) process.exitCode = 1; };
const parse = (value: string) => { try { const data = JSON.parse(value); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data as Record<string, unknown>; } catch { throw new LmsError('BAD_INPUT', 'Expected a JSON object.'); } };
let updateNotice: Promise<UpdateInfo> | undefined;
program.hook('preAction', (_command, action) => {
  // No extra network requests or text in pipes, MCP stdout, --json, help or worker processes.
  if (process.stdout.isTTY && process.stderr.isTTY && !program.opts().json && !action.opts().offline && !['mcp', 'mcp-config', 'update', 'doctor'].includes(action.name())) updateNotice = checkForUpdates({ automatic: true });
});

const schoolOptions = (command: Command) => {
  command.option('--label <name>', 'School/account display name').option('--timezone <zone>', 'School IANA timezone, e.g. Europe/London');
  for (const { id, label } of platformDefinitions) command.option(`--${id} <origin>`, `${label} HTTPS origin, without a login/course path`);
  return command;
};
schoolOptions(program.command('setup').description('一次完成终端配置、Codex 接入、必要授权和连接检查；可安全重跑')
  .option('--preset <name>', 'School preset, e.g. polyu').option('--id <id>', 'Optional account ID (generated automatically)')
  .option('--school <query>', '搜索学校名称或域名，在终端选择后配置；也用于添加另一所学校')
  .option('--platform <name>', '学校搜索平台：canvas 或 blackboard')
  .option('--offline', '仅搜索本地学校预设，不联网查询目录')
  .option('--manual', '直接填写学校平台网址')
  .option('-y, --yes', '确认给定的学校参数和本机配置；不能跳过学校 MFA')
  .option('--no-login', '只配置，不打开学校授权页面或检查私有接口')
  .option('--no-codex', '只使用 CLI，不修改 Codex 接入')
  .option('--replace-plugin', '确认替换已安装的同名 lms-cli 插件；不删除学校数据'))
  .action(async o => {
    const result = await setup({ ...o, platform: o.platform ? Platform.parse(o.platform) : undefined, profile: profileId() });
    if (!process.stdout.isTTY || program.opts().json) return out(result);
    const labels: Record<string, string> = { runtime: '运行环境', school: '学校配置', codex: 'Codex 接入', connection: '平台连接', authorization: '学校授权' };
    for (const step of result.steps) {
      const detail = step.detail as any;
      const summary = step.step === 'runtime' ? `lms-cli ${detail.version} · ${detail.os}/${detail.arch}`
        : Array.isArray(detail?.checks) ? `${detail.label} · 身份与课程列表${step.ok ? '检查通过' : '检查未通过'}`
        : detail?.message ?? detail?.note ?? detail?.label ?? (typeof detail === 'string' ? detail : '');
      process.stdout.write(`${step.ok ? '完成' : '待处理'} · ${labels[step.step] ?? step.step}: ${summary}\n`);
      if (detail?.hint) process.stdout.write(`  ${detail.hint}\n`);
      for (const check of detail?.checks ?? []) if (!check.ok) {
        process.stdout.write(`  ${check.platform}: ${check.error?.message ?? '连接失败'}\n`);
        if (check.error?.hint) process.stdout.write(`  ${check.error.hint}\n`);
      }
    }
    process.stdout.write(`${result.next}\n`); if (!result.ok) process.exitCode = 1;
  });
program.command('connect').description('Connect a client without changing schools or opening login windows')
  .command('codex').option('-y, --yes', 'Confirm local Codex integration').option('--replace-plugin', 'Replace explicitly identified old lms-cli plugins')
  .action(async o => out(await connectCodex(o)));
program.command('update').description('检查新版本；确认后升级托管 CLI，保留学校数据和上一版本')
  .option('--check', '只检查，不下载或安装').option('-y, --yes', '确认安装匹配的新版本')
  .option('--rollback', '回退到保留的上一版本，仍保留学校数据')
  .action(async o => {
    if (o.rollback && o.check) throw new LmsError('BAD_INPUT', '--rollback 和 --check 不能同时使用。');
    if (o.rollback) {
      if (!o.yes && (!interactive() || !await confirm('回退到上一版本？学校配置、凭据和待办不会删除'))) return out({ ok: false, next: '确认后运行 lms update --rollback --yes。' });
      const { rollback } = await import('./upgrade.js'); return out(await rollback());
    }
    const update = await checkForUpdates();
    if (o.check || update.status !== 'available') return out({ ok: update.status !== 'unavailable', ...update });
    if (!managedRoot() || !update.asset || !update.checksumUrl) {
      const next = !managedRoot() ? '当前是源码/npm 安装。请按开发指南更新，或使用自包含 CLI 安装命令。' : '当前系统缺少匹配安装包或校验和，请查看发布页面。';
      if (o.yes) throw new LmsError('UPDATE_NOT_INSTALLABLE', next, update.releaseUrl);
      return out({ ok: true, ...update, next });
    }
    if (!o.yes && (!interactive() || !await confirm(`从 ${update.current} 更新到 ${update.latest}？将校验下载文件并保留上一版本`))) return out({ ...update, next: '确认后运行 lms update --yes。' });
    const { upgrade } = await import('./upgrade.js'); out(await upgrade(update));
  });
schoolOptions(program.command('init').description('Create a custom school/account profile or use a preset').option('--preset <name>', 'Optional preset; see lms presets').option('--id <id>', 'Custom profile ID (lowercase letters, digits and hyphens)')).action(async o => out(await initProfile(o)));
program.command('presets').description('List school URL presets; a preset is not a compatibility certification').action(() => out(presets));
program.command('schools').description('发现学校平台地址，不读取账号、不登录或修改配置')
  .command('search <query>').description('按学校名称或域名搜索 Canvas 官方目录与本地预设')
  .option('--platform <name>', 'canvas 或 blackboard').option('--offline', '仅搜索本地预设')
  .action(async (query, o) => out(await searchSchools(query, { ...o, platform: o.platform ? Platform.parse(o.platform) : undefined })));
const profilesCommand = program.command('profiles').description('Manage school/account configurations; credentials stay isolated');
schoolOptions(profilesCommand.command('add <id>').description('Add a school/account; does not replace an existing profile or change the active profile')).action(async (id, o) => out(await addProfile({ id, ...o })));
profilesCommand.command('list').action(async () => out(await loadConfig()));
profilesCommand.command('use <id>').action(async id => out(await useProfile(id)));

const auth = program.command('auth').description('School authorization for the selected profile');
auth.command('login').option('--platform <name>', `${platformIds.join(' or ')}; omit for all`).action(async o => {
  const p = await getProfile(profileId()); const job = startLogin(p, o.platform ? Platform.parse(o.platform) : undefined);
  process.stderr.write(`已打开 ${p.label} 的登录窗口，请完成学校登录。完成后会自动继续。\n`);
  const state = await finishLogin(job.id); out({ ok: state === 'finished', state, ...(await authStatus(p)) });
});
auth.command('status').option('--live', 'Validate by a read request, instead of stored metadata only').action(async o => {
  if (!o.live) return out(await authStatus(await getProfile(profileId())));
  const result = await withBackend(profileId(), async (b, p) => Promise.all(platforms(p).map(platform => { const probe = getPlatform(platform).probes.identity; return b.call(p, probe.tool, probe.args, { fresh: true }); })));
  out({ ok: result.every(r => r.ok), results: result.map(({ platform, ok, error, fetchedAt }) => ({ platform, ok, error, fetchedAt })) });
});
auth.command('token').description('Import an institution-permitted Canvas token over stdin only').requiredOption('--stdin', 'Read token privately from stdin, not CLI arguments').action(async () => {
  if (process.stdin.isTTY) throw new LmsError('BAD_INPUT', 'Provide the token via a pipe from your password manager; do not put it in shell arguments.');
  let value = ''; for await (const c of process.stdin) { value += c; if (value.length > 16384) throw new LmsError('BAD_INPUT', 'Token is too long.'); }
  out(await validateInWorker(await getProfile(profileId()), 'canvas', { kind: 'token', value: value.trim() }));
});
auth.command('logout').requiredOption('--platform <name>', 'Remove authorization for this platform only').requiredOption('--yes', 'Confirm local credential removal; school session is not remotely revoked').action(async o => { const p = await getProfile(profileId()); const platform = Platform.parse(o.platform); await vault.remove(p, platform); out({ ok: true, profile: p.id, platform, locallySignedOut: true, remoteSessionRevoked: false }); });

program.command('tools').description('Discover tools; pass --name to inspect its exact JSON schema').option('--platform <name>').option('--query <text>').option('--name <tool>').action(async o => out(await withBackend(profileId(), (b, p) => b.catalog(p, { ...o, platform: o.platform ? Platform.parse(o.platform) : undefined }))));
program.command('call <tool>').description('Call an exact, reviewed upstream read tool').option('--args <json>', 'Arguments matching the tool schema', '{}').option('--fresh').action(async (tool, o) => out(await withBackend(profileId(), (b, p) => b.call(p, tool, parse(o.args), o))));
for (const platform of platformIds) {
  const { aliases, courseArgument: course } = getPlatform(platform);
  program.command(`${platform} <resource>`).description(`Read ${platform} resources. Aliases: ${Object.keys(aliases).join(', ')}`).option('--course <id>').option('--args <json>', 'Additional exact upstream parameters', '{}').option('--fresh').action(async (resource, o) => {
    const tool = Object.hasOwn(aliases, resource) ? aliases[resource]! : resource;
    if (platformFor(tool) !== platform) throw new LmsError('BAD_INPUT', 'Tool does not belong to this platform.');
    const args = parse(o.args);
    if (o.course) args[course.name] = course.type === 'number' ? Number(o.course) : o.course;
    out(await withBackend(profileId(), (b, p) => b.call(p, tool, args, o)));
  });
}
program.command('overview').description('Bounded evidence for schedules/changes; includes announcements, not only API deadlines').option('--days <n>', 'Look-ahead days', '14').option('--fresh').action(async o => out(await withBackend(profileId(), (b, p) => b.overview(p, Number(o.days), o.fresh))));
program.command('check').description('Live read-only identity/course-list checks; does not certify all features or open login windows').option('--platform <name>', `${platformIds.join(' or ')}; defaults to configured platforms`).action(async o => out(await withBackend(profileId(), (b, p) => b.check(p, o.platform ? Platform.parse(o.platform) : undefined))));
program.command('ask <question>').description('General natural-language query using your signed-in Codex CLI and the LMS MCP server').option('--model <name>', 'Optional Codex model override').action(async (question, o) => { process.stdout.write(await ask(await getProfile(profileId()), question, o.model)); });
program.command('mcp').description('Serve the general LMS capabilities over MCP stdio').action(async () => { const { serve } = await import('./mcp.js'); await serve(); });
program.command('mcp-config').description('Print portable-install MCP configuration; does not modify any client settings').action(() => out(mcpConfig()));

const items = program.command('items').description('Local source-backed tasks; never writes to the LMS');
items.command('list').action(async () => out(await listItems(await getProfile(profileId()))));
items.command('upsert').requiredOption('--file <json>', 'JSON array of source-backed items').action(async o => out(await upsertItems(await getProfile(profileId()), JSON.parse(await readFile(o.file, 'utf8')))));
items.command('export').requiredOption('--out <ics>', 'New output filename (existing files are not overwritten)').action(async o => { const p = await getProfile(profileId()); const result = exportCalendar(p, await listItems(p)); await writeFile(o.out, result.ics, { flag: 'wx', mode: 0o600 }); out({ ok: true, out: o.out, excluded: result.excluded, note: result.note }); });
program.command('doctor').description('Local diagnostics, without reading or printing credentials').action(async () => {
  out({ ...(await diagnostics()), stateHome: stateHome(), installation: managedRoot() ? 'managed' : 'npm-or-source', profiles: (await loadConfig()).profiles.map(p => p.id), readOnly: true, next: '运行 lms setup 自动完成缺失步骤。', note: 'Module loading is not an OS keychain or school login test. setup/check probe identity/course lists only; other features need separate acceptance.' });
});
// Electron RUN_AS_NODE has a Node-shaped argv; Commander's Electron auto-detection
// would otherwise interpret the script path as the command in packaged validators.
try { await program.parseAsync(process.argv, { from: 'node' }); }
catch (e) { out({ ok: false, error: publicError(e) }); process.exitCode = 1; }
if (updateNotice) {
  const update = await updateNotice;
  if (update.status === 'available') process.stderr.write(`\n${update.message}\n${update.releaseUrl}\n`);
}
