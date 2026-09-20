import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let electron: string | undefined;
try { electron = require('electron'); } catch {}
test('Electron Node-mode preserves CLI argv and loads the native keyring', { skip: !electron }, () => {
  const run = spawnSync(electron!, [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'doctor'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).nativeKeyringModuleLoads, true);
});
