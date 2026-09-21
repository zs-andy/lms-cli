import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { LmsError } from './errors.js';
import { platformIds } from './platforms/registry.js';

export const Platform = z.enum(platformIds);
export type Platform = z.infer<typeof Platform>;
export const ProfileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
export const Origin = z.string().transform((s, ctx) => {
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error();
    return u.origin;
  } catch { ctx.addIssue({ code: 'custom', message: 'Use an HTTPS origin only, with no path, query, or credentials.' }); return z.NEVER; }
});
const platformFields = Object.fromEntries(platformIds.map(id => [id, Origin.optional()])) as Record<Platform, z.ZodOptional<typeof Origin>>;
export const ProfileFields = {
  id: ProfileId,
  label: z.string().trim().min(1).max(100),
  timezone: z.string().refine(s => { try { new Intl.DateTimeFormat('en', { timeZone: s }); return true; } catch { return false; } }, 'Use an IANA timezone'),
  ...platformFields,
};
export const ProfileSchema = z.object(ProfileFields).strict().refine(p => platformIds.some(id => p[id]), 'Configure at least one platform');
export type Profile = z.infer<typeof ProfileSchema>;
const ConfigSchema = z.object({ version: z.literal(1), active: ProfileId.optional(), profiles: z.array(ProfileSchema) });
type Config = z.infer<typeof ConfigSchema>;

export function stateHome() {
  if (process.env.LMS_HOME) return resolve(process.env.LMS_HOME);
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return join(base, 'lms-cli');
}
export async function ensureHome() { await mkdir(stateHome(), { recursive: true, mode: 0o700 }); }
export async function atomicWrite(file: string, content: string | Buffer) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, content, { mode: 0o600, flag: 'wx' }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}
export async function locked<T>(fn: () => Promise<T>): Promise<T> {
  await ensureHome();
  const release = await lockfile.lock(stateHome(), { retries: { retries: 20, minTimeout: 50, maxTimeout: 200 }, stale: 30_000 });
  try { return await fn(); } finally { await release(); }
}
export async function loadConfig(): Promise<Config> {
  try { return ConfigSchema.parse(JSON.parse(await readFile(join(stateHome(), 'profiles.json'), 'utf8'))); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: [] };
    throw new LmsError('CONFIG_INVALID', 'Profile configuration is invalid; it has not been overwritten.');
  }
}
export async function addProfile(input: unknown) {
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) throw new LmsError('BAD_INPUT', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return locked(async () => {
    const config = await loadConfig();
    if (config.profiles.some(p => p.id === parsed.data.id)) throw new LmsError('PROFILE_EXISTS', 'That profile already exists. Use a new ID for another school/account.');
    config.profiles.push(parsed.data); config.active ??= parsed.data.id;
    await atomicWrite(join(stateHome(), 'profiles.json'), JSON.stringify(config, null, 2));
    return parsed.data;
  });
}
export async function useProfile(id: string) {
  return locked(async () => {
    const c = await loadConfig();
    if (!c.profiles.some(p => p.id === id)) throw new LmsError('PROFILE_NOT_FOUND', 'Unknown profile. Run lms profiles list.');
    c.active = id; await atomicWrite(join(stateHome(), 'profiles.json'), JSON.stringify(c, null, 2)); return { active: id };
  });
}
export async function getProfile(id?: string): Promise<Profile> {
  const c = await loadConfig(); const p = c.profiles.find(p => p.id === (id ?? c.active));
  if (!p) throw new LmsError('PROFILE_NOT_FOUND', 'School/account profile not found.', 'Run lms profiles list, lms init --help or lms profiles add --help. PolyU users can use lms init --preset polyu.');
  return p;
}
export function platforms(p: Profile): Platform[] { return platformIds.filter(k => p[k]); }
export const polyu = { id: 'polyu', label: 'The Hong Kong Polytechnic University', timezone: 'Asia/Hong_Kong', canvas: 'https://canvas.polyu.edu.hk', blackboard: 'https://learn.polyu.edu.hk' };

export const presets = [{ name: 'polyu', profile: polyu, compatibility: 'Preset URLs only; school SSO and individual features still require live verification.' }];

export async function initProfile(options: Partial<Profile> & { preset?: string }) {
  if (!options.preset) { const { preset: _preset, ...fields } = options; return addProfile(fields); }
  if (Object.entries(options).some(([key, value]) => key !== 'preset' && value !== undefined)) {
    throw new LmsError('BAD_INPUT', 'Choose either a preset or custom profile fields, not both.');
  }
  const preset = presets.find(p => p.name === options.preset);
  if (!preset) throw new LmsError('BAD_INPUT', 'Unknown preset. Run lms presets, or configure a custom school with lms init --help.');
  const existing = (await loadConfig()).profiles.find(p => p.id === preset.profile.id);
  if (existing && Object.entries(preset.profile).every(([key, value]) => existing[key as keyof Profile] === value)) return existing;
  return addProfile(preset.profile);
}
