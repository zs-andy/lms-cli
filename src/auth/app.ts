import { app, BrowserWindow, ipcMain, session, type Session as ElectronSession } from 'electron';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getProfile, loadConfig, Platform, platforms, type Profile, type Platform as PlatformType } from '../config.js';
import { cookieHeader, allowedNavigation } from './cookies.js';
import { validateInWorker } from './validate.js';
import { authorizationHTML } from './ui.js';
import { getPlatform } from '../platforms/registry.js';

let controller: BrowserWindow; let busy = false; let message = '准备登录'; let abort: AbortController | undefined;
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const fromCLI = process.argv.includes('--from-cli');
const fromProfile = arg('--profile');
const directLogin = fromCLI && Boolean(fromProfile);
const push = async () => { const c = await loadConfig(); const s = { profiles: c.profiles, active: fromProfile ?? c.active, lockedProfile: fromProfile, busy, message }; if (controller && !controller.isDestroyed()) controller.webContents.send('lms:update', s); return s; };

function harden(win: BrowserWindow) {
  win.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!allowedNavigation(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { parent: win, webPreferences: { session: win.webContents.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } };
  });
  win.webContents.on('did-create-window', child => harden(child));
}
async function authorize(p: Profile, platform: PlatformType, ephemeral: ElectronSession, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const win = new BrowserWindow({ show: true, width: 1040, height: 780, title: `lms-cli · ${p.label}`, webPreferences: { session: ephemeral, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    win.center();
    win.show();
    win.focus();
    win.moveTop();
    // LaunchServices can otherwise leave the newly-created window behind the
    // Codex window on macOS. Keep it floating briefly, then restore normal UX.
    win.setAlwaysOnTop(true, 'floating');
    setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 1500);
    harden(win); let done = false; let validating = false; let lastHeader = ''; let lastProbe = 0;
    const finish = (error?: Error) => { if (done) return; done = true; clearInterval(timer); signal.removeEventListener('abort', cancelled); if (!win.isDestroyed()) win.close(); error ? reject(error) : resolve(); };
    const cancelled = () => finish(new Error('cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    win.on('closed', () => { if (!done) finish(new Error('cancelled')); });
    const check = async () => {
      if (done || validating || signal.aborted || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (!allowedNavigation(url) || new URL(url).origin !== p[platform]) return;
      const header = cookieHeader(platform, p[platform]!, await ephemeral.cookies.get({ url: p[platform]! }));
      if (!header || (header === lastHeader && Date.now() - lastProbe < 12000)) return;
      lastHeader = header; lastProbe = Date.now(); validating = true;
      try {
        message = '正在确认登录…'; await push();
        await validateInWorker(p, platform, { kind: 'cookie', value: header, userAgent: win.webContents.getUserAgent() }, signal);
        message = '登录成功，可以返回终端或 Agent 客户端。'; await push(); finish();
      } catch { if (!done) { message = '登录未完成，请继续登录或重试。'; await push(); } }
      finally { validating = false; }
    };
    const timer = setInterval(() => { void check().catch(() => {}); }, 1200);
    // Let the institution's root route to its configured SSO/landing page.
    void win.loadURL(`${p[platform]}/`).catch(() => { message = '无法加载学校登录页面。请检查网络，或关闭窗口后重试。'; void push(); });
  });
}
async function start(profileId: string, selection: string) {
  if (busy) return;
  if (fromProfile && profileId !== fromProfile) throw new Error('Profile does not match the requested authorization');
  const p = await getProfile(profileId); const selected = selection === 'all' ? platforms(p) : [Platform.parse(selection)];
  if (selected.some(s => !p[s])) throw new Error('Platform missing');
  busy = true; abort = new AbortController();
  const ephemeral = session.fromPartition(`lms-login-${randomUUID()}`, { cache: false });
  ephemeral.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ephemeral.setPermissionCheckHandler(() => false);
  ephemeral.on('will-download', event => event.preventDefault());
  const timeout = setTimeout(() => abort?.abort(), 15 * 60_000);
  let success = false;
  try {
    for (const platform of selected) { message = `请完成 ${p.label} 的 ${getPlatform(platform).label} 登录。`; await push(); await authorize(p, platform, ephemeral, abort.signal); }
    message = '登录成功，可以返回终端或 Agent 客户端。';
    success = true;
  } catch { message = '登录未完成，请重试。'; }
  finally { clearTimeout(timeout); abort?.abort(); await ephemeral.clearStorageData(); await ephemeral.clearCache(); busy = false; await push(); }
  if (fromCLI) app.exit(success ? 0 : 2);
}

app.on('window-all-closed', () => { abort?.abort(); app.exit(busy ? 2 : 0); });

// Do not use top-level `await app.whenReady()` here. Electron emits the ready
// event only after the main module returns to its event loop; awaiting it while
// evaluating the entry module can deadlock the packaged app before any window
// exists (the process remains alive but appears to flicker or do nothing).
async function boot() {
  await app.whenReady();
  controller = new BrowserWindow({ show: !directLogin, width: 500, height: 740, title: 'lms-cli', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  controller.center();
  if (!directLogin) { controller.show(); controller.focus(); controller.moveTop(); controller.setAlwaysOnTop(true, 'floating'); }
  setTimeout(() => { if (!controller.isDestroyed()) controller.setAlwaysOnTop(false); }, 1500);
  controller.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controller.webContents.on('will-navigate', e => e.preventDefault());
  controller.on('close', () => { abort?.abort(); for (const w of BrowserWindow.getAllWindows()) if (w !== controller) w.destroy(); });
  ipcMain.handle('lms:state', e => { if (e.sender !== controller.webContents) throw new Error(); return push(); });
  ipcMain.handle('lms:login', (e, id, platform) => { if (e.sender !== controller.webContents) throw new Error(); void start(id, platform).catch(() => { message = '无法开始登录，请重试。'; void push(); }); });
  await controller.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(authorizationHTML())}`);
  if (!directLogin) { controller.show(); controller.focus(); controller.moveTop(); }
  if (fromProfile) void start(fromProfile, arg('--platform') ?? 'all').catch(() => { message = '暂时无法连接所选学校，请在终端检查学校配置。'; if (fromCLI) app.exit(2); else void push(); });
}

void boot().catch(() => { app.exit(1); });
