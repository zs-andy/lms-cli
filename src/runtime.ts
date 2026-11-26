import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { stateHome } from './config.js';

export type InstallManager = 'homebrew' | 'scoop' | 'winget';
export type InstallKind = InstallManager | 'managed' | 'npm-or-source';

export const PACKAGE_MANAGER_UPGRADE_COMMANDS: Readonly<Record<InstallManager, string>> = {
  homebrew: 'brew upgrade lms-cli',
  scoop: 'scoop update lms-cli',
  winget: 'winget upgrade --id zs-andy.lms-cli',
};

export function parseInstallManager(value: string | undefined): InstallManager | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'homebrew' || normalized === 'brew') return 'homebrew';
  if (normalized === 'scoop') return 'scoop';
  if (normalized === 'winget') return 'winget';
  return undefined;
}

export function installManager(
  env: NodeJS.ProcessEnv = process.env,
  modulePath = fileURLToPath(import.meta.url),
): InstallManager | undefined {
  const explicit = parseInstallManager(env.LMS_INSTALL_MANAGER);
  if (explicit) return explicit;
  const normalizedPath = modulePath.replace(/\\/g, '/');
  if (/\/Cellar\/lms-cli\//.test(normalizedPath) || /\/homebrew\/opt\/lms-cli\//.test(normalizedPath)) {
    return 'homebrew';
  }
  if (/\/scoop\/apps\/lms-cli\//i.test(normalizedPath)) {
    return 'scoop';
  }
  if (/\/WinGet\/Packages\/zs-andy\.lms-cli/i.test(normalizedPath)) {
    return 'winget';
  }
  return undefined;
}

export function installationKind(
  env: NodeJS.ProcessEnv = process.env,
  modulePath = fileURLToPath(import.meta.url),
): InstallKind {
  const manager = installManager(env, modulePath);
  if (manager) return manager;
  const root = env.LMS_INSTALL_ROOT;
  return root && isAbsolute(root) ? 'managed' : 'npm-or-source';
}

export function upgradeGuidance(manager: InstallManager): string {
  return `当前通过 ${manager} 包管理器安装。请使用 \`${PACKAGE_MANAGER_UPGRADE_COMMANDS[manager]}\` 升级或回退，不要使用内置自更新覆盖包管理器目录。`;
}

export function managedRoot(env: NodeJS.ProcessEnv = process.env, modulePath = fileURLToPath(import.meta.url)) {
  if (installManager(env, modulePath)) return undefined;
  const root = env.LMS_INSTALL_ROOT;
  return root && isAbsolute(root) ? root : undefined;
}

/** Managed and package-manager installs use a stable launcher so upgrades do not leave Codex pinned to old code. */
export function mcpConfig() {
  const launcher = process.env.LMS_INSTALL_LAUNCHER;
  const stableLauncher = launcher && isAbsolute(launcher) ? launcher : undefined;
  const root = managedRoot();
  const command = stableLauncher
    ? stableLauncher
    : root
      ? process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : join(root, 'bin', 'lms')
      : process.execPath;
  const args = stableLauncher
    ? ['mcp']
    : root
      ? process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'bin', 'lms.ps1'), 'mcp']
        : ['mcp']
      : [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp'];
  return { mcpServers: { lms: { command, args, env: {
    LMS_HOME: stateHome(),
    ...(!stableLauncher && !root && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(process.env.LMS_AUTH_APP ? { LMS_AUTH_APP: process.env.LMS_AUTH_APP } : {}),
    ...(process.env.LMS_UPDATE_CHECK === '0' ? { LMS_UPDATE_CHECK: '0' } : {}),
  } } } };
}
