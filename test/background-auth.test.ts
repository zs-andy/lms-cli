import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { authCommand, isBackgroundAuth, startLogin, waitLogin } from '../src/auth/launch.js';
import { addProfile, type Profile } from '../src/config.js';

const profile: Profile = {
  id: 'bg-test-school',
  label: 'Background Test University',
  timezone: 'UTC',
  canvas: 'https://canvas.example.invalid',
};

test('isBackgroundAuth only activates on explicit LMS_AUTH_BACKGROUND=1', () => {
  assert.equal(isBackgroundAuth({}), false);
  assert.equal(isBackgroundAuth({ LMS_AUTH_BACKGROUND: '0' }), false);
  assert.equal(isBackgroundAuth({ LMS_AUTH_BACKGROUND: 'true' }), false);
  assert.equal(isBackgroundAuth({ LMS_AUTH_BACKGROUND: '1' }), true);
});

test('authCommand passes --background and macOS -g -j flags only in background mode', () => {
  const macApp = '/Applications/lms-cli.app';
  const interactive = authCommand(profile, 'canvas', {
    env: { LMS_AUTH_APP: macApp },
    platformOs: 'darwin',
    electronPath: () => null,
  });
  assert.equal(interactive.background, false);
  assert.equal(interactive.command, '/usr/bin/open');
  assert.deepEqual(interactive.args, ['-W', '-na', macApp, '--args', '--profile', profile.id, '--platform', 'canvas', '--from-cli']);

  const bgMac = authCommand(profile, 'canvas', {
    env: { LMS_AUTH_APP: macApp, LMS_AUTH_BACKGROUND: '1' },
    platformOs: 'darwin',
    electronPath: () => null,
  });
  assert.equal(bgMac.background, true);
  assert.equal(bgMac.command, '/usr/bin/open');
  assert.deepEqual(bgMac.args, ['-W', '-g', '-j', '-na', macApp, '--args', '--profile', profile.id, '--platform', 'canvas', '--from-cli', '--background']);

  const bgElectron = authCommand(profile, undefined, {
    env: { LMS_AUTH_BACKGROUND: '1' },
    platformOs: 'linux',
    electronPath: () => '/usr/bin/fake-electron',
  });
  assert.equal(bgElectron.background, true);
  assert.equal(bgElectron.command, '/usr/bin/fake-electron');
  assert.ok(bgElectron.args.includes('--background'));
  assert.ok(bgElectron.args.includes('--from-cli'));
});

test('startLogin forwards windowsHide, background metadata, and non-contradictory notes', async () => {
  const prevBg = process.env.LMS_AUTH_BACKGROUND;
  const prevApp = process.env.LMS_AUTH_APP;
  const prevHome = process.env.LMS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'lms-bg-launch-'));
  const spawned: Array<{ command: string; args: readonly string[]; windowsHide?: boolean }> = [];
  const fakeSpawn = ((command: string, args: readonly string[], opts: { windowsHide?: boolean }) => {
    spawned.push({ command, args, windowsHide: opts.windowsHide });
    const child = new EventEmitter() as ChildProcess;
    setImmediate(() => child.emit('close', 2));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  try {
    process.env.LMS_HOME = home;
    await addProfile(profile);
    process.env.LMS_AUTH_APP = '/tmp/fake-lms-auth';
    process.env.LMS_AUTH_BACKGROUND = '1';
    const bgJob = startLogin(profile, 'canvas', fakeSpawn);
    assert.equal(bgJob.background, true);
    assert.equal(spawned.at(-1)?.windowsHide, true);
    assert.ok(spawned.at(-1)?.args.includes('--background'));
    assert.match(bgJob.note, /without visible windows/i);
    assert.doesNotMatch(bgJob.note, /authorization window is already open/i);
    const waitedBg = await waitLogin(bgJob.id, 1000);
    assert.equal(waitedBg.background, true);
    assert.equal(waitedBg.state, 'cancelled');

    delete process.env.LMS_AUTH_BACKGROUND;
    const fgJob = startLogin(profile, 'canvas', fakeSpawn);
    assert.equal(fgJob.background, false);
    assert.equal(spawned.at(-1)?.windowsHide, false);
    assert.ok(!spawned.at(-1)?.args.includes('--background'));
    assert.match(fgJob.note, /Cancel with Esc/);
    const waitedFg = await waitLogin(fgJob.id, 1000);
    assert.equal(waitedFg.background, false);
  } finally {
    if (prevBg === undefined) delete process.env.LMS_AUTH_BACKGROUND; else process.env.LMS_AUTH_BACKGROUND = prevBg;
    if (prevApp === undefined) delete process.env.LMS_AUTH_APP; else process.env.LMS_AUTH_APP = prevApp;
    if (prevHome === undefined) delete process.env.LMS_HOME; else process.env.LMS_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});
