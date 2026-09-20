import { getProfile, Platform } from './config.js';
import { installCredentials, validateCredential } from './adapter.js';
import { vault, type Secret } from './vault.js';
import { publicError } from './errors.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

try {
  const p = await getProfile(process.argv[3]); const platform = Platform.parse(process.argv[2]);
  if (process.argv[4] === 'validate') {
    let input = ''; for await (const c of process.stdin) { input += c; if (input.length > 220_000) throw new Error(); }
    const candidate = JSON.parse(input) as Omit<Secret, 'validatedAt'>;
    const secret = await validateCredential(p, platform, candidate);
    await vault.write(p, platform, secret);
    process.stdout.write(JSON.stringify({ ok: true, platform, validatedAt: secret.validatedAt }));
  } else {
    await installCredentials(p, platform);
    if (platform === 'canvas') await import('../vendor/canvas/src/index.js');
    else {
      const { createServer } = await import('../vendor/blackboard/src/server.js');
      // No upstream browser-cookie import, CLI login, or SSO session keeper.
      await createServer().connect(new StdioServerTransport());
    }
  }
} catch (e) {
  if (process.argv[4] === 'validate') process.stdout.write(JSON.stringify({ ok: false, error: publicError(e) }));
  process.exitCode = 1;
}
