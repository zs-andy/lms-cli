import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMachOMagic, machOFiles, macReleaseConfig } from '../scripts/macos-release.mjs';

test('release signing is opt-in and requires a real Developer ID name plus a Keychain profile', () => {
  assert.equal(macReleaseConfig({}, 'darwin'), null);
  assert.equal(macReleaseConfig({}, 'linux'), null);
  const env = { LMS_MAC_SIGN_IDENTITY: 'Developer ID Application: Example (A123456789)', LMS_NOTARY_PROFILE: 'release' };
  assert.deepEqual(macReleaseConfig(env, 'darwin'), { identity: env.LMS_MAC_SIGN_IDENTITY, profile: 'release', teamId: 'A123456789' });
  for (const bad of [{ LMS_MAC_RELEASE: '1' }, { ...env, LMS_NOTARY_PROFILE: '' }, { ...env, LMS_MAC_SIGN_IDENTITY: '-' }, { ...env, LMS_MAC_SIGN_IDENTITY: 'Apple Development: Example (A123456789)' }, { ...env, LMS_NOTARY_PROFILE: 'bad\nprofile' }]) assert.throws(() => macReleaseConfig(bad, 'darwin'));
  assert.throws(() => macReleaseConfig(env, 'linux'));
});

test('signing inventory recognizes both byte orders and universal Mach-O binaries', () => {
  for (const magic of ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) assert.equal(isMachOMagic(Buffer.from(magic, 'hex')), true);
  assert.equal(isMachOMagic(Buffer.from('not a native binary')), false);
  assert.equal(isMachOMagic(Buffer.alloc(3)), false);
});

test('signing inventory does not follow framework links or external symlinks', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lms-sign-inventory-'));
  try {
    await mkdir(join(root, 'Versions/A'), { recursive: true });
    const binary = join(root, 'Versions/A/framework');
    await writeFile(binary, Buffer.from('cffaedfe00000000', 'hex'));
    await writeFile(join(root, 'text.txt'), 'documentation');
    await symlink('A', join(root, 'Versions/Current'));
    await symlink('Versions/Current/framework', join(root, 'framework'));
    await symlink(root, join(root, 'loop'));
    assert.deepEqual(await machOFiles(root), [binary]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
