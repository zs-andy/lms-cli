import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { stateHome } from './config.js';

export function managedRoot() {
  const root = process.env.LMS_INSTALL_ROOT;
  return root && isAbsolute(root) ? root : undefined;
}

/** Managed installs use a stable launcher so upgrades do not leave Codex pinned to old code. */
export function mcpConfig() {
  const root = managedRoot();
  const command = root ? process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : join(root, 'bin', 'lms') : process.execPath;
  const args = root ? process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'bin', 'lms.ps1'), 'mcp']
    : ['mcp'] : [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp'];
  return { mcpServers: { lms: { command, args, env: {
    LMS_HOME: stateHome(),
    ...(!root && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(process.env.LMS_AUTH_APP ? { LMS_AUTH_APP: process.env.LMS_AUTH_APP } : {}),
    ...(process.env.LMS_UPDATE_CHECK === '0' ? { LMS_UPDATE_CHECK: '0' } : {}),
  } } } };
}
