import { getProfile, Platform } from './config.js';
import { installCredentials, validateCredential } from './adapter.js';
import { vault } from './vault.js';
import type { CredentialCandidate } from './platforms/types.js';
import { publicError } from './errors.js';

try {
  const p = await getProfile(process.argv[3]); const platform = Platform.parse(process.argv[2]);
  if (process.argv[4] === 'validate') {
    let input = ''; for await (const c of process.stdin) { input += c; if (input.length > 220_000) throw new Error(); }
    const candidate = JSON.parse(input) as CredentialCandidate;
    const secret = await validateCredential(p, platform, candidate);
    await vault.write(p, platform, secret);
    process.stdout.write(JSON.stringify({ ok: true, platform, validatedAt: secret.validatedAt }));
  } else {
    const runtime = await installCredentials(p, platform);
    await runtime.serve();
  }
} catch (e) {
  if (process.argv[4] === 'validate') process.stdout.write(JSON.stringify({ ok: false, error: publicError(e) }));
  process.exitCode = 1;
}
