import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProfile, type Platform, type Profile, platforms } from '../config.js';
import { vault, type Secret } from '../vault.js';
import { LmsError } from '../errors.js';
import { installedElectron } from './runtime.js';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
type Job = {
  id: string;
  profile: string;
  platforms: Platform[];
  background: boolean;
  state: 'running' | 'finished' | 'cancelled';
  startedAt: string;
  child?: ChildProcess;
  done: Promise<void>;
};
const jobs = new Map<string, Job>();

export function isBackgroundAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LMS_AUTH_BACKGROUND === '1';
}

export async function authStatus(p: Profile) {
  const results = await Promise.all(platforms(p).map(async platform => {
    const saved = await vault.read<Secret>(p, platform);
    return { platform, authorized: !!saved, validatedAt: saved?.value.validatedAt ?? null, liveChecked: false };
  }));
  return {
    profile: p.id,
    platforms: results,
    jobs: [...jobs.values()]
      .filter(j => j.profile === p.id)
      .map(j => ({ id: j.id, state: j.state, background: j.background, startedAt: j.startedAt, platforms: j.platforms })),
    note: 'Stored authorization is not proof the session is still live. Use auth status --live or a read call.',
  };
}

export function authCommand(
  profile: Profile,
  platform: Platform | undefined,
  options: { env?: NodeJS.ProcessEnv; platformOs?: NodeJS.Platform; hasFile?: (path: string) => boolean; electronPath?: () => string | null } = {},
) {
  const env = options.env ?? process.env;
  const osPlatform = options.platformOs ?? process.platform;
  const hasFile = options.hasFile ?? existsSync;
  const resolveElectron = options.electronPath ?? installedElectron;
  const args = ['--profile', profile.id, '--platform', platform ?? 'all', '--from-cli'];
  const background = isBackgroundAuth(env);
  if (background) args.push('--background');
  const configured = env.LMS_AUTH_APP;
  const macCandidates = [
    join(homedir(), 'Applications', 'lms-cli.app'),
    '/Applications/lms-cli.app',
  ];
  const winCandidates = osPlatform === 'win32' ? [
    join(env.LOCALAPPDATA ?? '', 'Programs', 'lms-cli', 'lms-cli.exe'),
    join(env.LOCALAPPDATA ?? '', 'lms-cli', 'lms-cli.exe'),
  ] : [];
  const unixCandidates = osPlatform === 'linux' ? [
    join(homedir(), '.local', 'share', 'lms-cli', 'lms-cli'),
    '/usr/local/bin/lms-cli',
    '/usr/bin/lms-cli',
  ] : [];
  // Prefer the matching bundled runtime over an older installed PolyU-only app.
  if (!configured) {
    try {
      const electron = resolveElectron();
      if (typeof electron === 'string' && electron) return { command: electron, args: [fileURLToPath(new URL('../../../', import.meta.url)), ...args], background };
    } catch {}
  }
  const candidate = configured || [...macCandidates, ...winCandidates, ...unixCandidates].find(hasFile);

  // macOS must go through `open -na`: launching the inner executable directly
  // can leave an invisible app process and does not reliably present a window.
  if (osPlatform === 'darwin' && candidate?.endsWith('.app')) {
    return { command: '/usr/bin/open', args: ['-W', ...(background ? ['-g', '-j'] : []), '-na', candidate, '--args', ...args], background };
  }
  if (candidate) return { command: candidate, args, background };

  throw new LmsError('AUTH_APP_MISSING', 'The lms-cli authorization app is not installed.', 'Reinstall lms-cli with optional dependencies or install the current lms-cli app. An old PolyU-only authorization app is not a supported fallback.');
}

export function startLogin(p: Profile, platform?: Platform, spawnImpl: typeof spawn = spawn) {
  if (platform && !p[platform]) throw new LmsError('NOT_CONFIGURED', 'That platform is not configured.');
  const existing = [...jobs.values()].find(j => j.profile === p.id && j.state === 'running');
  if (existing) return { id: existing.id, state: existing.state, background: existing.background, profile: existing.profile, platforms: existing.platforms, note: 'An authorization attempt is already running. Wait for it to finish.' };

  const selected = platform ? [platform] : platforms(p);
  if (!selected.length) throw new LmsError('NOT_CONFIGURED', 'No LMS platform is configured for this profile.');
  const launch = authCommand(p, platform);
  const startedAt = new Date().toISOString();
  let child: ChildProcess;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawnImpl(launch.command, launch.args, { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: launch.background });
  } catch {
    throw new LmsError('AUTH_APP_START_FAILED', 'The authorization app could not be started.', 'Check that the installed app is executable and try again.');
  }

  const id = randomUUID();
  const job: Job = { id, profile: p.id, platforms: selected, background: launch.background, state: 'running', startedAt, child, done: Promise.resolve() };
  job.done = new Promise<void>(resolve => {
    child.once('error', () => { job.state = 'cancelled'; resolve(); });
    // `open -W` waits for the app just like a directly spawned Electron process.
    // Closing the login window must not leave the CLI waiting for 15 minutes.
    child.once('close', () => {
      void authorizedFor(job).then(valid => { job.state = valid ? 'finished' : 'cancelled'; resolve(); }, () => { job.state = 'cancelled'; resolve(); });
    });
  });
  jobs.set(id, job);
  for (const [key, old] of jobs) if (jobs.size > 10 && old.state !== 'running') jobs.delete(key);
  return {
    id,
    state: job.state,
    background: job.background,
    profile: p.id,
    platforms: selected,
    note: job.background
      ? 'Background authorization is running without visible windows. Existing automatic-login consent is required. Missing consent, MFA, unsupported forms or timeouts do not open a window; unsuccessful authorization is reported as cancelled. Wait, then retry the read. To repair login interactively, run lms auth login with LMS_AUTH_BACKGROUND unset.'
      : 'The authorization app restores saved login preferences: remember-password fills only; automatic login fills and submits once. Complete any remaining school verification there. Cancel with Esc or the cancel button. No password/Cookie copying is needed; completion requires locally verified encrypted credentials.',
  };
}

export function isFreshAuthorization(platforms: Awaited<ReturnType<typeof authStatus>>['platforms'], requested: Platform[], startedAt: string) {
  return requested.every(platform => platforms.some(s => s.platform === platform && s.authorized && s.validatedAt !== null && Date.parse(s.validatedAt) >= Date.parse(startedAt)));
}

async function authorizedFor(job: Job) {
  const p = await getProfile(job.profile);
  const status = await authStatus(p);
  return isFreshAuthorization(status.platforms, job.platforms, job.startedAt);
}

async function waitForAuthorization(job: Job, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, LOGIN_TIMEOUT_MS));
  while (job.state === 'running') {
    if (await authorizedFor(job)) {
      job.state = 'finished';
      break;
    }
    if (Date.now() - Date.parse(job.startedAt) >= LOGIN_TIMEOUT_MS) { job.state = 'cancelled'; break; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(50, deadline - Date.now()))));
  }
}

export async function waitLogin(id: string, timeoutMs = 20_000) {
  const job = jobs.get(id);
  if (!job) throw new LmsError('NOT_FOUND', 'Authorization job not found in this process. Check lms_auth_status.');
  await waitForAuthorization(job, timeoutMs);
  return { id, state: job.state, background: job.background, profile: job.profile, platforms: job.platforms };
}

export async function finishLogin(id: string, timeoutMs = LOGIN_TIMEOUT_MS) {
  const job = jobs.get(id);
  if (!job) throw new LmsError('NOT_FOUND', 'Authorization job not found in this process.');
  await waitForAuthorization(job, timeoutMs);
  return job.state;
}
