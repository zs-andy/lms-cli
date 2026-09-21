// Release-only signing. Credentials remain in the user's Keychain; no password arguments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, open, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { signAsync } from '@electron/osx-sign';

const exec = promisify(execFile);
export const jitEntitlements = fileURLToPath(new URL('./entitlements-jit.plist', import.meta.url));
export const electronAppIn = stage => join(stage, 'app/node_modules/electron/dist/Electron.app');

export function macReleaseConfig(env = process.env, platform = process.platform) {
  const identity = env.LMS_MAC_SIGN_IDENTITY?.trim();
  const profile = env.LMS_NOTARY_PROFILE?.trim();
  if (!identity && !profile && env.LMS_MAC_RELEASE !== '1') return null;
  if (platform !== 'darwin') throw new Error('macOS release signing must run on macOS.');
  const match = /^Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\)$/.exec(identity ?? '');
  if (!match || !profile || /[\x00-\x1f]/.test(profile)) throw new Error('Set LMS_MAC_SIGN_IDENTITY to a Developer ID Application name and LMS_NOTARY_PROFILE to an existing Keychain profile.');
  return { identity, profile, teamId: match[1] };
}

export async function command(binary, args, options = {}) {
  return exec(binary, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

export function isMachOMagic(bytes) {
  return bytes.length >= 4 && ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.subarray(0, 4).toString('hex'));
}

export async function machOFiles(directory) {
  const found = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const fd = await open(child, 'r');
        try { const bytes = Buffer.alloc(4); const { bytesRead } = await fd.read(bytes, 0, 4, 0); if (bytesRead === 4 && isMachOMagic(bytes)) found.push(child); }
        finally { await fd.close(); }
      }
      // Never follow framework links: sign each actual file once, preserve relative links.
    }
  }
  await walk(directory);
  return found.sort();
}

export async function verifyMacSignature(path, teamId) {
  await command('codesign', ['--verify', '--strict', '--all-architectures', path]);
  const { stderr } = await command('codesign', ['--display', '--verbose=4', path]);
  if (!stderr.includes(`TeamIdentifier=${teamId}\n`) || !stderr.includes('Authority=Developer ID Application:') || !/flags=.*runtime/.test(stderr) || !/Timestamp=/.test(stderr)) throw new Error(`Missing distributor signature, hardened runtime or secure timestamp: ${path}`);
}

export async function signStandaloneMac(stage, config) {
  const app = electronAppIn(stage);
  const node = join(stage, 'runtime/node');
  const files = await machOFiles(stage);
  console.log(`Signing ${files.length} Mach-O files for team ${config.teamId}.`);
  for (const path of files.filter(path => !path.startsWith(`${app}/`))) {
    await command('codesign', ['--force', '--sign', config.identity, '--options', 'runtime', '--timestamp', ...(path === node ? ['--entitlements', jitEntitlements] : []), path]);
  }
  await signAsync({ app, identity: config.identity, platform: 'darwin', type: 'distribution', strictVerify: true,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: path => path === app ? { entitlements: jitEntitlements } : {} });
  await command('codesign', ['--verify', '--deep', '--strict', app]);
  for (const path of files) await verifyMacSignature(path, config.teamId);
  const state = await mkdtemp(join(tmpdir(), 'lms-sign-check-'));
  try {
    const env = { ...process.env, LMS_HOME: state, LMS_UPDATE_CHECK: '0' };
    const doctor = JSON.parse((await command(node, [join(stage, 'app/bin/lms.js'), 'doctor'], { env })).stdout);
    if (!doctor.nativeKeyringModuleLoads || !doctor.authorizationRuntimeInstalled) throw new Error('Signed standalone runtime failed its native module checks.');
    await command(join(app, 'Contents/MacOS/Electron'), ['-e', "require('@napi-rs/keyring'); console.log('Signed Electron native module loaded')"], {
      cwd: join(stage, 'app'), env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } finally { await rm(state, { recursive: true, force: true }); }
  console.log('Signed Node and Electron native module checks passed.');
  return files.map(path => relative(stage, path));
}

export async function notarizeFile(path, config, recordPath) {
  console.log(`Submitting ${path.split('/').pop()} to Apple notarization.`);
  // Save the submission ID before waiting, so a network interruption can be resumed.
  const submitted = JSON.parse((await command('xcrun', ['notarytool', 'submit', path, '--keychain-profile', config.profile, '--output-format', 'json'], { timeout: 900_000 })).stdout);
  if (!/^[a-f0-9-]{36}$/i.test(submitted.id ?? '')) throw new Error('Apple did not return a notarization submission ID.');
  await writeFile(recordPath, JSON.stringify({ id: submitted.id, status: 'Submitted', teamId: config.teamId }, null, 2));
  console.log(`Notarization submission: ${submitted.id}`);
  try {
    await command('xcrun', ['notarytool', 'wait', submitted.id, '--keychain-profile', config.profile, '--output-format', 'json', '--timeout', '30m'], { timeout: 1_860_000 });
  } finally {
    const result = JSON.parse((await command('xcrun', ['notarytool', 'info', submitted.id, '--keychain-profile', config.profile, '--output-format', 'json'])).stdout);
    await writeFile(recordPath, JSON.stringify({ id: result.id, status: result.status, teamId: config.teamId, createdDate: result.createdDate }, null, 2));
  }
  const log = JSON.parse((await command('xcrun', ['notarytool', 'log', submitted.id, '--keychain-profile', config.profile])).stdout);
  if (log.status !== 'Accepted') {
    await writeFile(`${recordPath}.log.json`, JSON.stringify(log, null, 2));
    throw new Error(`Notarization was not accepted. Inspect ${recordPath}.log.json before publishing.`);
  }
  console.log(`Apple notarization Accepted: ${submitted.id}`);
  return submitted.id;
}

export async function notarizeStandaloneMac(stage, config, recordPath) {
  const work = await mkdtemp(join(tmpdir(), 'lms-notary-'));
  try {
    const zip = join(work, 'lms-cli-macos.zip');
    await command('/usr/bin/ditto', ['-c', '-k', '--keepParent', stage, zip], { timeout: 300_000 });
    await notarizeFile(zip, config, recordPath);
    const app = electronAppIn(stage);
    await command('xcrun', ['stapler', 'staple', app]);
    await command('xcrun', ['stapler', 'validate', app]);
    await command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    await command('codesign', ['--verify', '--deep', '--strict', app]);
    await verifyMacSignature(join(stage, 'runtime/node'), config.teamId);
    console.log('Notarized authorization app ticket and Gatekeeper assessment passed.');
  } finally { await rm(work, { recursive: true, force: true }); }
}
