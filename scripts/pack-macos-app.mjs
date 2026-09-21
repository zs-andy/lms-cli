import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';
import { macReleaseConfig, command, notarizeFile, verifyMacSignature, jitEntitlements } from './macos-release.mjs';

const config = macReleaseConfig({ ...process.env, LMS_MAC_RELEASE: '1' });
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
process.env.APPLE_KEYCHAIN_PROFILE = config.profile;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
const artifacts = await build({ projectDir: root, targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch[process.arch]), config: {
  forceCodeSigning: true,
  mac: { identity: config.identity.replace(/^Developer ID Application: /, ''), type: 'distribution', hardenedRuntime: true,
    notarize: true, entitlements: jitEntitlements, entitlementsInherit: jitEntitlements },
} });
const app = join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'lms-cli.app');
await verifyMacSignature(app, config.teamId);
await command('codesign', ['--verify', '--deep', '--strict', app]);
await command('xcrun', ['stapler', 'validate', app]);
await command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
for (const dmg of artifacts.filter(path => path.endsWith('.dmg'))) {
  await command('codesign', ['--force', '--sign', config.identity, '--timestamp', dmg]);
  await notarizeFile(dmg, config, `${dmg}.notarization.json`);
  await command('xcrun', ['stapler', 'staple', dmg]);
  await command('xcrun', ['stapler', 'validate', dmg]);
  await command('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
}
console.log(`Signed and notarized optional macOS authorization app ${pkg.version}.`);
