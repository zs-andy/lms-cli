import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * All state lives under one root so `auth logout --purge` and manual cleanup
 * are a single directory removal.
 */
export function stateDir(): string {
  const override = process.env.BLACKBOARD_MCP_HOME;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, 'blackboard-mcp');
  return join(homedir(), '.blackboard-mcp');
}

export const configPath = (): string => join(stateDir(), 'config.json');
export const sessionPath = (): string => join(stateDir(), 'session.enc');
export const keyfilePath = (): string => join(stateDir(), 'key');
export const profilePath = (): string => join(stateDir(), 'endpoints.json');
export const cacheDir = (): string => join(stateDir(), 'cache');

/** Where downloaded attachments land by default. */
export function downloadDir(): string {
  return (
    process.env.BLACKBOARD_MCP_DOWNLOAD_DIR ??
    join(stateDir(), 'downloads')
  );
}

export function scratchDir(): string {
  return join(tmpdir(), 'blackboard-mcp');
}

/** Creates a directory with owner-only permissions, idempotently. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
