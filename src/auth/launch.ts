import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProfile, type Platform, type Profile, platforms } from '../config.js';
import { vault, type Secret } from '../vault.js';
import { LmsError } from '../errors.js';

const require = createRequire(import.meta.url);
const LOGIN_TIMEOUT_MS = 15 * 60_000;
type Job = {
  id: string;
  profile: string;
  platforms: Platform[];
  state: 'running' | 'finished' | 'cancelled';
  startedAt: string;
  child?: ChildProcess;
  done: Promise<void>;
};
const jobs = new Map<string, Job>();

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
      .map(j => ({ id: j.id, state: j.state, startedAt: j.startedAt, platforms: j.platforms })),
    note: 'Stored authorization is not proof the session is still live. Use auth status --live or a read call.',
  };
}

function authCommand(profile: Profile, platform: Platform | undefined) {
  const args = ['--profile', profile.id, '--platform', platform ?? 'all', '--from-cli'];
  const configured = process.env.LMS_AUTH_APP;
  const macCandidates = [
    join(homedir(), 'Applications', 'LMS Authorization.app'),
    '/Applications/LMS Authorization.app',
  ];
  const winCandidates = process.platform === 'win32' ? [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LMS Authorization', 'LMS Authorization.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'LMS Authorization', 'LMS Authorization.exe'),
  ] : [];
  const unixCandidates = process.platform === 'linux' ? [
    join(homedir(), '.local', 'share', 'LMS Authorization', 'lms-authorization'),
    '/usr/local/bin/lms-authorization',
    '/usr/bin/lms-authorization',
  ] : [];
  const candidate = configured || [...macCandidates, ...winCandidates, ...unixCandidates].find(existsSync);

  // macOS must go through `open -na`: launching the inner executable directly
  // can leave an invisible app process and does not reliably present a window.
  if (process.platform === 'darwin' && candidate?.endsWith('.app')) {
    return { command: '/usr/bin/open', args: ['-na', candidate, '--args', ...args] };
  }
  if (candidate) return { command: candidate, args };

  try {
    const electron = require('electron');
    if (typeof electron !== 'string' || !electron) throw new Error();
    const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
    return { command: electron, args: [packageRoot, ...args] };
  } catch {
    throw new LmsError(
      'AUTH_APP_MISSING',
      'The cross-platform authorization app is not installed.',
      'Install the LMS Authorization app or set LMS_AUTH_APP to its executable path.',
    );
  }
}

export function startLogin(p: Profile, platform?: Platform) {
  if (platform && !p[platform]) throw new LmsError('NOT_CONFIGURED', 'That platform is not configured.');
  const existing = [...jobs.values()].find(j => j.profile === p.id && j.state === 'running');
  if (existing) return { id: existing.id, state: existing.state, profile: existing.profile, platforms: existing.platforms, note: 'An authorization window is already open. Finish it first.' };

  const selected = platform ? [platform] : platforms(p);
  if (!selected.length) throw new LmsError('NOT_CONFIGURED', 'No LMS platform is configured for this profile.');
  const launch = authCommand(p, platform);
  let child: ChildProcess;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(launch.command, launch.args, { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
  } catch {
    throw new LmsError('AUTH_APP_START_FAILED', 'The authorization app could not be started.', 'Check that the installed app is executable and try again.');
  }

  const id = randomUUID();
  const job: Job = { id, profile: p.id, platforms: selected, state: 'running', startedAt: new Date().toISOString(), child, done: Promise.resolve() };
  job.done = new Promise<void>(resolve => {
    child.once('error', () => { job.state = 'cancelled'; resolve(); });
    // `open -na` exits as soon as it hands off to LaunchServices. Its exit is
    // deliberately not treated as authorization completion; the vault is the
    // source of truth and is polled by waitLogin.
    child.once('close', () => {});
  });
  jobs.set(id, job);
  for (const [key, old] of jobs) if (jobs.size > 10 && old.state !== 'running') jobs.delete(key);
  return {
    id,
    state: job.state,
    profile: p.id,
    platforms: selected,
    note: 'Complete your school login and MFA in the authorization app. No password/Cookie copying is needed. Authorization completes when encrypted credentials are verified in the local vault.',
  };
}

async function authorizedFor(job: Job) {
  const p = await getProfile(job.profile);
  const status = await authStatus(p);
  return job.platforms.every(platform => status.platforms.find(s => s.platform === platform)?.authorized);
}

async function waitForAuthorization(job: Job, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, LOGIN_TIMEOUT_MS));
  while (job.state === 'running') {
    if (await authorizedFor(job)) {
      job.state = 'finished';
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(50, deadline - Date.now()))));
  }
}

export async function waitLogin(id: string, timeoutMs = 20_000) {
  const job = jobs.get(id);
  if (!job) throw new LmsError('NOT_FOUND', 'Authorization job not found in this process. Check lms_auth_status.');
  await waitForAuthorization(job, timeoutMs);
  return { id, state: job.state, profile: job.profile, platforms: job.platforms };
}

export async function finishLogin(id: string, timeoutMs = LOGIN_TIMEOUT_MS) {
  const job = jobs.get(id);
  if (!job) throw new LmsError('NOT_FOUND', 'Authorization job not found in this process.');
  await waitForAuthorization(job, timeoutMs);
  return job.state;
}
