import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Profile, type Platform } from '../config.js';
import { LmsError } from '../errors.js';
import type { CredentialCandidate } from '../platforms/types.js';

/** Secret travels only over a private pipe; never command-line arguments, renderer IPC or logs. */
export async function validateInWorker(p: Profile, platform: Platform, candidate: CredentialCandidate, signal?: AbortSignal): Promise<{ ok: true; platform: Platform; validatedAt: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.js', import.meta.url)), platform, p.id, 'validate'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal });
    let text = ''; const timer = setTimeout(() => { child.kill(); reject(new LmsError('AUTH_TIMEOUT', 'Session validation timed out.')); }, 40_000);
    child.stdout.on('data', data => { text += data.toString(); if (text.length > 4000) child.kill(); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new LmsError('AUTH_CANCELLED', 'Authorization was cancelled or the validator could not start.')); });
    child.on('close', () => { clearTimeout(timer); try {
      const result = JSON.parse(text);
      if (result.ok) resolve(result);
      else reject(new LmsError(result.error?.code ?? 'AUTH_FAILED', result.error?.message ?? 'Session validation failed.', result.error?.hint));
    } catch { reject(new LmsError('AUTH_FAILED', 'Session validation did not complete.')); } });
    child.stdin.end(JSON.stringify(candidate));
  });
}
