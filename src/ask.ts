import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { type Profile, stateHome } from './config.js';
import { workflowInstructions } from './policy.js';
import { LmsError } from './errors.js';

function codexExecutable() {
  if (process.env.LMS_CODEX_BIN) return { command: process.env.LMS_CODEX_BIN, prefix: [] as string[] };
  try {
    const req = createRequire(import.meta.url);
    return { command: process.execPath, prefix: [req.resolve('@openai/codex/bin/codex.js')] };
  } catch {}
  if (process.platform === 'darwin') {
    for (const candidate of ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'])
      if (existsSync(candidate)) return { command: candidate, prefix: [] as string[] };
  }
  // shell=false deliberately; Windows users can supply the real codex.exe via LMS_CODEX_BIN.
  return { command: 'codex', prefix: [] as string[] };
}
export function codexArguments(p: Profile, cwd: string, output: string) {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'browser_use', '--disable', 'computer_use', '--color', 'never', '-C', cwd, '-o', output,
    '-c', `mcp_servers.lms.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.lms.args=${JSON.stringify([cli, 'mcp'])}`,
    '-c', `mcp_servers.lms.env.LMS_HOME=${JSON.stringify(stateHome())}`,
    ...(process.env.LMS_AUTH_APP ? ['-c', `mcp_servers.lms.env.LMS_AUTH_APP=${JSON.stringify(process.env.LMS_AUTH_APP)}`] : []),
    '-c', 'mcp_servers.lms.startup_timeout_sec=20',
    '-c', 'mcp_servers.lms.tool_timeout_sec=180', '-'];
}
export async function ask(p: Profile, question: string, model?: string) {
  if (!question.trim()) throw new LmsError('BAD_INPUT', 'Enter a question.');
  const cwd = await mkdtemp(join(tmpdir(), 'lms-ask-')); const output = join(cwd, 'answer.txt');
  const { command, prefix } = codexExecutable();
  const args = [...prefix, ...codexArguments(p, cwd, output)]; if (model) args.splice(args.length - 1, 0, '--model', model);
  try {
    process.stderr.write('正在通过 Codex 查询 LMS；学校内容会交由你的 Codex 模型处理。\n');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { shell: false, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      // Avoid streaming private document bodies / internal transcripts into terminal logs.
      child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
      const onSignal = () => child.kill(); process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      const timer = setTimeout(() => { child.kill(); reject(new LmsError('ASK_TIMEOUT', 'Codex did not finish within 5 minutes. Narrow the question or continue in the Codex app.')); }, 300_000);
      const clean = () => { clearTimeout(timer); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); };
      child.once('error', () => { clean(); reject(new LmsError('CODEX_UNAVAILABLE', 'Codex CLI could not be started.', 'Install/sign in to Codex CLI, or set LMS_CODEX_BIN to its executable. No separate model API key is required.')); });
      child.once('close', code => { clean(); code === 0 ? resolve() : reject(new LmsError('CODEX_FAILED', `Codex exited with status ${code ?? 'signal'}.`, 'Check codex login status and update Codex. This command requires exec --ignore-user-config support. You can also use the MCP plugin directly in Codex.')); });
      child.stdin.end(`${workflowInstructions}\nProfile: ${p.id}; timezone: ${p.timezone}; today: ${new Date().toISOString()}. Pass profile=${p.id} to every profile-scoped tool. Do not use shell, browser, computer, filesystem or other non-LMS tools. Answer only the user's request.\nUser request:\n${question}`);
    });
    return await readFile(output, 'utf8');
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
