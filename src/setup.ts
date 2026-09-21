import { addProfile, getProfile, initProfile, loadConfig, Origin, platforms, presets, type Profile } from './config.js';
import { platformDefinitions } from './platforms/registry.js';
import { finishLogin, startLogin } from './auth/launch.js';
import { withBackend } from './backend.js';
import { connectCodex } from './codex.js';
import { LmsError, publicError } from './errors.js';
import { confirm, interactive, question } from './terminal.js';
import { VERSION } from './version.js';
import { installedElectron } from './auth/runtime.js';
import { selectSchool } from './school-selection.js';
import type { SchoolSearchOptions } from './schools.js';

export type SetupOptions = Partial<Profile> & SchoolSearchOptions & { school?: string; manual?: boolean; preset?: string; yes?: boolean; login?: boolean; codex?: boolean; replacePlugin?: boolean; profile?: string };

export async function chooseProfile(options: SetupOptions, ask = question, approve = confirm, find = selectSchool) {
  const existing = await loadConfig();
  const hasOrigins = platformDefinitions.some(p => options[p.id]);
  const custom = Boolean(options.id || options.label || options.timezone || hasOrigins);
  const discovery = options.school !== undefined || Boolean(options.manual || options.platform || options.offline);
  if (options.school !== undefined && (options.manual || platformDefinitions.some(p => options[p.id]))) throw new LmsError('BAD_INPUT', '请选择学校搜索或手动网址配置，不要混用。');
  if (options.preset && discovery) throw new LmsError('BAD_INPUT', '预设不能与学校搜索参数混用。');
  if (options.preset && custom) throw new LmsError('BAD_INPUT', '预设不能与自定义学校参数混用。');
  if (options.profile && (custom || options.preset || discovery)) throw new LmsError('BAD_INPUT', '--profile 选择已有账号，不能与新增学校参数混用。');
  if (options.profile) return getProfile(options.profile);
  if (!custom && !options.preset && !discovery && existing.active) return getProfile();
  const preset = options.preset;
  if (!preset && !options.manual && !hasOrigins) {
    if (options.yes || (ask === question && !interactive())) throw new LmsError('INPUT_REQUIRED', '搜索结果需要在终端选择并核对网址。非交互配置请提供明确的平台地址或预设。', '运行 lms schools search "学校名称"，再使用 --canvas / --blackboard 和 --timezone 配置。');
    const selected = await find(options.school, { platform: options.platform, offline: options.offline }, ask);
    if (selected) options = { ...options, ...selected.platforms, label: options.label || selected.name, timezone: options.timezone || selected.timezone };
  }
  if (preset && preset !== 'custom') {
    const p = presets.find(p => p.name === preset)?.profile;
    if (!p) throw new LmsError('BAD_INPUT', '未知预设。运行 lms presets 查看可选学校。');
    if (!options.yes && !await approve(`连接 ${p.label}，${platforms(p).map(k => p[k]).join('、')}，时区 ${p.timezone}？`)) throw new LmsError('CANCELLED', '已取消；没有保存学校配置。');
    return initProfile({ preset });
  }
  const fields: Partial<Profile> = {};
  for (const { id, label } of platformDefinitions) {
    const value = options[id] ?? (platformDefinitions.some(p => options[p.id]) ? '' : await ask(`${label} HTTPS 根网址（不用则留空）`));
    if (value) {
      const parsed = Origin.safeParse(value.trim());
      if (!parsed.success) throw new LmsError('BAD_INPUT', `${label} 请使用 HTTPS 根网址，不含 /login、课程路径或账号参数。`);
      fields[id] = parsed.data;
    }
  }
  const origin = platformDefinitions.map(p => fields[p.id]).find(Boolean);
  if (!origin) throw new LmsError('BAD_INPUT', '至少提供一个学习平台网址。');
  const suggested = new URL(origin).hostname.replace(/[^a-z0-9]+/g, '-').slice(0, 36);
  fields.label = options.label || new URL(origin).hostname;
  fields.timezone = options.timezone || (options.yes ? undefined : await ask('学校时区（请核对，不一定等于电脑时区）', Intl.DateTimeFormat().resolvedOptions().timeZone));
  if (!fields.timezone) throw new LmsError('INPUT_REQUIRED', '非交互配置需要明确学校时区。', '请添加 --timezone Asia/Hong_Kong 等 IANA 时区。');
  if (options.id) {
    const sameId = existing.profiles.find(p => p.id === options.id);
    if (sameId && Object.entries(fields).every(([k, v]) => sameId[k as keyof Profile] === v) && platforms(sameId).every(k => fields[k] === sameId[k])) return sameId;
    fields.id = options.id;
  } else {
    const same = existing.profiles.find(p => Object.entries(fields).every(([k, v]) => p[k as keyof Profile] === v) && platforms(p).every(k => fields[k] === p[k]));
    if (same) return same;
    fields.id = suggested;
    for (let n = 2; existing.profiles.some(p => p.id === fields.id); n++) fields.id = `${suggested}-${n}`;
  }
  if (!options.yes && !await approve(`保存 ${fields.label}，${platformDefinitions.map(p => fields[p.id]).filter(Boolean).join('、')}，时区 ${fields.timezone}？`)) throw new LmsError('CANCELLED', '已取消；没有保存学校配置。');
  return addProfile(fields);
}

export async function diagnostics() {
  let authorizationRuntimeInstalled = false, nativeKeyringModuleLoads = false;
  authorizationRuntimeInstalled = Boolean(installedElectron());
  try { await import('@napi-rs/keyring'); nativeKeyringModuleLoads = true; } catch {}
  return { version: VERSION, node: process.version, os: process.platform, arch: process.arch, authorizationRuntimeInstalled, nativeKeyringModuleLoads };
}

export async function setup(options: SetupOptions) {
  const steps: Array<{ step: string; ok: boolean; detail: unknown }> = [];
  const local = await diagnostics();
  steps.push({ step: 'runtime', ok: local.nativeKeyringModuleLoads, detail: local });
  if (!local.nativeKeyringModuleLoads) return { ok: false, steps, next: '运行安装命令修复当前系统的依赖。不会删除已有学校配置。' };
  const p = await chooseProfile(options);
  const resume = `lms --profile ${p.id} setup`;
  steps.push({ step: 'school', ok: true, detail: { id: p.id, label: p.label, timezone: p.timezone } });
  if (options.codex !== false) {
    try { steps.push({ step: 'codex', ok: true, detail: await connectCodex(options) }); }
    catch (error) { steps.push({ step: 'codex', ok: false, detail: publicError(error) }); }
  }
  let ready = false;
  if (options.login !== false) {
    try {
      const before = await withBackend(p.id, (b, profile) => b.check(profile));
      if (before.ok) { ready = true; steps.push({ step: 'connection', ok: true, detail: before }); }
      else {
        const missing = [...new Set(before.checks.filter(c => c.error?.code === 'AUTH_REQUIRED').map(c => c.platform))];
        if (!missing.length) { steps.push({ step: 'connection', ok: false, detail: before }); }
        else {
          if (!options.yes && !interactive()) throw new LmsError('INPUT_REQUIRED', '学校需要登录；请在终端运行 lms setup，或加 --no-login 先完成配置。');
          process.stderr.write(`只有授权这一步需要学校网页：请完成 ${p.label} 的登录及 MFA。已有有效授权的平台不会重复登录。\n`);
          for (const platform of missing.length === platforms(p).length ? [undefined] : missing) {
            const job = startLogin(p, platform);
            const state = await finishLogin(job.id);
            if (state !== 'finished') throw new LmsError('AUTH_REQUIRED', `登录未完成或已取消。配置已保留，运行 ${resume} 继续。`);
          }
          const after = await withBackend(p.id, (b, profile) => b.check(profile));
          ready = after.ok;
          steps.push({ step: 'connection', ok: ready, detail: after });
        }
      }
    } catch (error) { steps.push({ step: 'connection', ok: false, detail: publicError(error) }); }
  } else steps.push({ step: 'authorization', ok: true, detail: `已跳过登录；运行 ${resume} 完成授权和连接检查。` });
  return { ok: steps.every(s => s.ok), profile: p.id, ready, steps, next: ready ? `已连接 ${p.label}。运行 lms --profile ${p.id} overview 查询；默认账号保持不变。Codex 插件首次接入后请新建任务。连接检查覆盖身份及课程列表。` : `运行 ${resume} 继续，或按失败步骤的提示处理。已有账号和默认选择均保留。` };
}
