import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { sessionPath, stateDir, ensureDir } from '../lib/paths.js';
import { resolveKey, deleteKey } from '../lib/keyring.js';
import { BlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * AES-256-GCM envelope: [12-byte IV][16-byte auth tag][ciphertext].
 * Small enough to keep inline; avoids a crypto dependency.
 */
const IV_LEN = 12;
const TAG_LEN = 16;

export async function writeSecret(payload: unknown): Promise<void> {
  const key = await resolveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  ensureDir(stateDir());
  writeFileSync(sessionPath(), envelope, { mode: 0o600 });
  log.debug('Session written', { bytes: envelope.length });
}

export async function readSecret<T>(): Promise<T | null> {
  const file = sessionPath();
  if (!existsSync(file)) return null;
  const envelope = readFileSync(file);
  if (envelope.length < IV_LEN + TAG_LEN) {
    throw new BlackboardError('INTERNAL', 'Stored session file is truncated.', {
      hint: 'Run `blackboard-mcp auth logout --purge` then sign in again.',
    });
  }
  const key = await resolveKey();
  const iv = envelope.subarray(0, IV_LEN);
  const tag = envelope.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = envelope.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch (cause) {
    // Wrong key almost always means the keychain entry was removed or the
    // state dir was copied between machines.
    throw new BlackboardError('NOT_AUTHENTICATED', 'Could not decrypt the stored session.', {
      hint: 'The encryption key no longer matches. Run `blackboard-mcp auth logout --purge`, then `blackboard-mcp auth login`.',
      cause,
    });
  }
}

export async function purgeSecret(alsoKey = false): Promise<void> {
  rmSync(sessionPath(), { force: true });
  if (alsoKey) await deleteKey();
}
