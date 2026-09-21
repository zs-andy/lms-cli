import { type Platform, type Profile, stateHome } from './config.js';
import { type Secret, vault } from './vault.js';
import { LmsError } from './errors.js';
import { getPlatform, isPlatformEnvironment } from './platforms/registry.js';
import type { CredentialCandidate, RuntimeContext } from './platforms/types.js';

/** Worker-only boundary: clear every upstream namespace before loading vendor code. */
export async function configureEnvironment(p: Profile, platform: Platform) {
  const origin = p[platform];
  if (!origin) throw new LmsError('NOT_CONFIGURED', 'Platform is not configured for this profile.');
  for (const key of Object.keys(process.env)) if (isPlatformEnvironment(key)) delete process.env[key];
  const runtime = await getPlatform(platform).loadRuntime();
  const context: RuntimeContext = { profileId: p.id, origin, stateHome: stateHome() };
  runtime.configure(context);
  return { runtime, context };
}

/** Passwords and IdP cookies never enter this boundary. Validation errors are redacted. */
export async function validateCredential(p: Profile, platform: Platform, candidate: CredentialCandidate): Promise<Secret> {
  if (!candidate || !['cookie', 'token'].includes(candidate.kind) || typeof candidate.value !== 'string' || !candidate.value || candidate.value.length > 200_000 || /[\r\n]/.test(candidate.value) ||
    (candidate.userAgent !== undefined && (typeof candidate.userAgent !== 'string' || candidate.userAgent.length > 4096 || /[\r\n]/.test(candidate.userAgent)))) {
    throw new LmsError('BAD_INPUT', 'Invalid credential input.');
  }
  const { runtime, context } = await configureEnvironment(p, platform);
  try { return await runtime.validate(context, candidate); }
  catch { throw new LmsError('AUTH_FAILED', 'The platform did not confirm this session.', 'Finish the school login and MFA. Expired or rejected sessions do not replace existing credentials.'); }
}

export async function installCredentials(p: Profile, platform: Platform) {
  const { runtime, context } = await configureEnvironment(p, platform);
  const stored = await vault.read<Secret>(p, platform);
  await runtime.install(context, stored?.value ?? null, async credential => {
    // A stale worker cannot replace a new login or resurrect a logged-out session.
    if (stored) await vault.write(p, platform, credential, stored.generation);
  });
  return runtime;
}
