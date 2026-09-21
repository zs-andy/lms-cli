import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { LmsError } from './errors.js';

export const interactive = () => Boolean(stdin.isTTY && stderr.isTTY);
export async function question(message: string, fallback?: string): Promise<string> {
  if (!interactive()) throw new LmsError('INPUT_REQUIRED', '非交互环境需要完整参数；没有修改未确认的配置。', '运行 lms setup --help，或在终端运行 lms setup。');
  const rl = createInterface({ input: stdin, output: stderr });
  try { return (await rl.question(`${message}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback || ''; }
  finally { rl.close(); }
}
export async function confirm(message: string) { return /^(y|yes|是)$/i.test(await question(`${message} [y/N]`)); }
