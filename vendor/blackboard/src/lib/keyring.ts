import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { platform } from 'node:os';
import { keyfilePath, stateDir, ensureDir } from './paths.js';
import { log } from './logger.js';

const run = promisify(execFile);

const SERVICE = 'blackboard-mcp';
const ACCOUNT = 'session-encryption-key';

/**
 * Resolves the 32-byte key used to encrypt the session at rest.
 *
 * Preference order:
 *   1. OS keychain (macOS `security`, Linux `secret-tool`). Key never touches disk.
 *   2. A 0600 keyfile under the state dir. Portable fallback.
 *
 * The fallback is deliberately not treated as a failure: it is still strictly
 * better than a plaintext session file, and it keeps the package dependency-free
 * (no native `keytar` build step, which is a common install blocker).
 */
export async function resolveKey(): Promise<Buffer> {
  const fromOs = await readFromOsKeychain();
  if (fromOs) return fromOs;

  const generated = randomBytes(32);
  if (await writeToOsKeychain(generated)) return generated;

  return readOrCreateKeyfile();
}

async function readFromOsKeychain(): Promise<Buffer | null> {
  try {
    if (platform() === 'darwin') {
      const { stdout } = await run('security', [
        'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
      ]);
      const hex = stdout.trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
      return null;
    }
    if (platform() === 'linux') {
      const { stdout } = await run('secret-tool', [
        'lookup', 'service', SERVICE, 'account', ACCOUNT,
      ], { timeout: 5000 });
      const hex = stdout.trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
      return null;
    }
  } catch {
    // Not found, or the tool is unavailable. Fall through to the next strategy.
  }
  return null;
}

async function writeToOsKeychain(key: Buffer): Promise<boolean> {
  const hex = key.toString('hex');
  try {
    if (platform() === 'darwin') {
      await run('security', [
        'add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', hex, '-U',
      ]);
      log.debug('Stored session key in macOS keychain');
      return true;
    }
    if (platform() === 'linux') {
      await run('secret-tool', [
        'store', '--label=Blackboard MCP session key',
        'service', SERVICE, 'account', ACCOUNT,
      ], { input: hex, timeout: 5000 } as never);
      log.debug('Stored session key in Secret Service');
      return true;
    }
  } catch {
    log.debug('OS keychain unavailable; using keyfile fallback');
  }
  return false;
}

function readOrCreateKeyfile(): Buffer {
  const path = keyfilePath();
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    if (hex.length === 64) return Buffer.from(hex, 'hex');
  }
  ensureDir(stateDir());
  const key = randomBytes(32);
  writeFileSync(path, key.toString('hex'), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** Removes the key from wherever it lives. Used by `auth logout --purge`. */
export async function deleteKey(): Promise<void> {
  try {
    if (platform() === 'darwin') {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    } else if (platform() === 'linux') {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
    }
  } catch {
    // Nothing stored; not an error.
  }
}
