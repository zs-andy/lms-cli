import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Electron 44's package entry can download binaries and print to stdout. Never require it in a CLI/MCP diagnostic. */
export function installedElectron(): string | undefined {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
    const relative = readFileSync(join(root, 'path.txt'), 'utf8').trim();
    if (!relative || isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return undefined;
    const binary = join(root, 'dist', relative);
    return existsSync(binary) ? binary : undefined;
  } catch { return undefined; }
}
