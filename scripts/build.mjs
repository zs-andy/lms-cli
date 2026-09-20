import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../dist/', import.meta.url));
// Only this project's generated output, never a caller-provided directory.
await rm(output, { recursive: true, force: true });
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
