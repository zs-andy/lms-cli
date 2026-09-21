import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, ensureHome, locked, stateHome, type Platform, type Profile } from './config.js';
import { LmsError } from './errors.js';
import { platformIds } from './platforms/registry.js';
import type { StoredCredential } from './platforms/types.js';

export type Secret = StoredCredential;
export interface KeyProvider { get(): Promise<Buffer | null>; set(key: Buffer): Promise<void>; }
class SystemKey implements KeyProvider {
  private async entry() {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('org.lmscli.vault', createHash('sha256').update(stateHome()).digest('hex').slice(0, 32), { linux: { store: 'secret-service' } });
  }
  async get() { const s = (await this.entry()).getPassword(); return s ? Buffer.from(s, 'base64') : null; }
  async set(key: Buffer) { (await this.entry()).setPassword(key.toString('base64')); }
}
type Envelope = { version: 1; generation: string; iv: string; tag: string; data: string };

/** AES-GCM payloads; only the random encryption key lives in the OS credential manager. No file-key fallback. */
export class Vault {
  private key?: Buffer;
  constructor(private provider: KeyProvider = new SystemKey()) {}
  private async resolveKey(create: boolean) {
    if (this.key) return this.key;
    try {
      let key = await this.provider.get();
      if (!key && create) { key = randomBytes(32); await this.provider.set(key); }
      if (!key || key.length !== 32) throw new Error();
      this.key = key; return key;
    } catch { throw new LmsError('KEYCHAIN_UNAVAILABLE', 'System credential storage is unavailable or locked.', 'Unlock Keychain / Windows Credential Manager / Linux Secret Service. No plaintext fallback is used.'); }
  }
  private name(p: Profile, slot: string) {
    // Preserve the exact v0.2/v0.3 key for existing profiles, even after registering new platforms.
    const legacy = `${p.id}\0${slot}\0${p.canvas ?? ''}\0${p.blackboard ?? ''}`;
    const additional = platformIds.filter(id => id !== 'canvas' && id !== 'blackboard' && p[id]).sort().map(id => [id, p[id]]);
    return createHash('sha256').update(legacy + (additional.length ? `\0${JSON.stringify(additional)}` : '')).digest('hex');
  }
  private path(p: Profile, slot: string) { return join(stateHome(), `${this.name(p, slot)}.vault`); }
  async generation(p: Profile, slot: string): Promise<string | null> {
    try { return (JSON.parse(await readFile(this.path(p, slot), 'utf8')) as Envelope).generation; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new LmsError('VAULT_INVALID', 'Encrypted state is unreadable; it was not overwritten.'); }
  }
  async read<T>(p: Profile, slot: string): Promise<{ generation: string; value: T } | null> {
    let raw: string;
    try { raw = await readFile(this.path(p, slot), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    const key = await this.resolveKey(false);
    try {
      const e = JSON.parse(raw) as Envelope;
      if (e.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${this.name(p, slot)}\0${e.generation}`)); decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      const clear = Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]);
      return { generation: e.generation, value: JSON.parse(clear.toString('utf8')) as T };
    } catch { throw new LmsError('VAULT_INVALID', 'Encrypted state failed verification.', 'Sign in again to replace credentials. Do not copy encrypted files between machines.'); }
  }
  async write<T>(p: Profile, slot: string, value: T, expected?: string): Promise<string | null> {
    return locked(() => this.writeUnlocked(p, slot, value, expected));
  }
  async update<T>(p: Profile, slot: string, change: (previous: T | null) => T) {
    return locked(async () => {
      const old = await this.read<T>(p, slot);
      const value = change(old?.value ?? null);
      await this.writeUnlocked(p, slot, value); return value;
    });
  }
  private async writeUnlocked<T>(p: Profile, slot: string, value: T, expected?: string): Promise<string | null> {
      const previous = await this.generation(p, slot);
      // Stale upstream workers cannot overwrite a newly authorized or logged-out session.
      if (expected !== undefined && previous !== expected) return null;
      const generation = expected ?? randomUUID(); const key = await this.resolveKey(true);
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${this.name(p, slot)}\0${generation}`));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const e: Envelope = { version: 1, generation, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      await ensureHome(); await atomicWrite(this.path(p, slot), JSON.stringify(e)); return generation;
  }
  async remove(p: Profile, slot: Platform) {
    await locked(() => rm(this.path(p, slot), { force: true }));
  }
}
export const vault = new Vault();
