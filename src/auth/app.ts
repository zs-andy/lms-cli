import { app, BrowserWindow, ipcMain, session, type WebContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session as ElectronSession } from 'electron';
import { fileURLToPath } from 'node:url';
import { getProfile, loadConfig, Platform, platforms, type Profile, type Platform as PlatformType } from '../config.js';
import { cookieHeader, allowedNavigation } from './cookies.js';
import { validateInWorker } from './validate.js';
import { authorizationHTML } from './ui.js';
import { attachSchoolPage } from './school-view.js';
import { loginStore, loginPage, loginSummary, canRestoreLogin, matchesLoginForm, LoginOptions, LoginAttempt, type LoginSummary } from './preferences.js';

let controller: BrowserWindow; let busy = false; let message = '准备登录'; let abort: AbortController | undefined;
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const fromCLI = process.argv.includes('--from-cli');
const fromProfile = arg('--profile');
const directLogin = fromCLI && Boolean(fromProfile);
// Opt-in for unattended CLI/MCP runs; never silently enables password consent.
const backgroundLogin = directLogin && (process.env.LMS_AUTH_BACKGROUND === '1' || process.argv.includes('--background'));
if (backgroundLogin && process.platform === 'darwin') app.setActivationPolicy('prohibited');
let currentPlatform: PlatformType | undefined;
let loginUrl = '';
let optionsPending: Promise<void> = Promise.resolve();
let optionsSaving = false;
const preferences: Record<string, Partial<Record<PlatformType, LoginSummary>>> = Object.create(null);
type LoginContext = LoginAttempt & { windows: Set<BrowserWindow>; contents: Set<WebContents> };
const loginWindows = new Map<number, LoginContext>();
let activeLogin: { profile: Profile; platforms: PlatformType[]; automationStopped: boolean } | undefined;
function stopAutomation() {
  if (activeLogin) activeLogin.automationStopped = true;
  for (const context of new Set(loginWindows.values())) {
    context.stopAutomation();
    for (const contents of context.contents) if (!contents.isDestroyed()) contents.send('lms:stop-automation');
  }
}
function cancelLogin() {
  if (!busy) return;
  stopAutomation();
  message = '正在取消本次登录…';
  abort?.abort();
}
function persistentPartition(profileId: string, platform: PlatformType) {
  return `persist:lms-login-${profileId}-${platform}`;
}
async function clearPersistentPartition(profileId: string, platform: PlatformType) {
  const stored = session.fromPartition(persistentPartition(profileId, platform));
  await stored.clearStorageData(); await stored.clearCache();
}
const push = async () => { const c = await loadConfig(); const s = { profiles: c.profiles, active: fromProfile ?? c.active, lockedProfile: activeLogin?.profile.id ?? fromProfile, lockedPlatform: fromProfile ? arg('--platform') : undefined, currentPlatform, loginUrl, preferences, busy, message }; if (controller && !controller.isDestroyed()) controller.webContents.send('lms:update', s); return s; };
function loginSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame) return;
  const context = loginWindows.get(event.sender.id);
  const page = loginPage(event.senderFrame.url);
  return context && page ? { context, page } : undefined;
}

function harden(contents: WebContents, context: LoginContext) {
  context.contents.add(contents);
  const id = contents.id;
  loginWindows.set(id, context);
  contents.on('destroyed', () => { loginWindows.delete(id); context.contents.delete(contents); });
  contents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); cancelLogin(); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowedNavigation(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { parent: controller, ...(backgroundLogin ? { show: false, focusable: false } : {}), webPreferences: { disableDialogs: backgroundLogin, backgroundThrottling: !backgroundLogin, session: contents.session, preload: fileURLToPath(new URL('./login-preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } };
  });
  contents.on('did-create-window', child => { context.windows.add(child); child.on('closed', () => context.windows.delete(child)); harden(child.webContents, context); });
}
async function authorize(p: Profile, platform: PlatformType, ephemeral: ElectronSession, signal: AbortSignal) {
  signal.throwIfAborted();
  await optionsPending;
  let saved = null;
  let savedTotp = null;
  try {
    [saved, savedTotp] = await Promise.all([loginStore.read(p, platform), loginStore.readTotp(p, platform)]);
  }
  catch { message = '无法读取已保存密码，请手动登录。'; await push(); }
  const context: LoginContext = Object.assign(new LoginAttempt(saved, savedTotp), { windows: new Set<BrowserWindow>(), contents: new Set<WebContents>() });
  signal.throwIfAborted();
  if (activeLogin?.automationStopped) context.stopAutomation();
  await new Promise<void>((resolve, reject) => {
    controller.setTitle(`lms-cli · ${p.label}`);
    controller.setContentSize(1040, 780);
    const school = attachSchoolPage(controller, ephemeral, backgroundLogin);
    const contents = school.contents;
    harden(contents, context); let done = false; let validating = false; let lastHeader = ''; let lastProbe = 0;
    const finish = (error?: Error) => { if (done) return; done = true; clearInterval(timer); signal.removeEventListener('abort', cancelled); context.cancel(); school.close(); for (const child of [...context.windows]) if (!child.isDestroyed()) child.destroy(); error ? reject(error) : resolve(); };
    const cancelled = () => finish(new Error('cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    contents.on('destroyed', () => { if (!done) finish(new Error('cancelled')); });
    contents.on('did-navigate', (_event, url) => { if (!done) { loginUrl = loginPage(url) ?? ''; void push(); } });
    const check = async () => {
      if (done || validating || signal.aborted || contents.isDestroyed() || contents.isLoadingMainFrame()) return;
      const url = contents.getURL();
      if (!allowedNavigation(url) || new URL(url).origin !== p[platform]) return;
      const header = cookieHeader(platform, p[platform]!, await ephemeral.cookies.get({ url: p[platform]! }));
      if (!header || (header === lastHeader && Date.now() - lastProbe < 12000)) return;
      lastHeader = header; lastProbe = Date.now(); validating = true;
      try {
        message = '正在确认登录…'; await push();
        await validateInWorker(p, platform, { kind: 'cookie', value: header, userAgent: contents.getUserAgent() }, signal);
        await optionsPending;
        if (done || signal.aborted) return;
        if (context.record?.rememberPassword && context.candidate) {
          try {
            await loginStore.saveVerified(p, platform, context.candidate);
            if (done || signal.aborted) return;
            (preferences[p.id] ??= {})[platform] = loginSummary(await loginStore.read(p, platform), await loginStore.readTotp(p, platform));
            if (done || signal.aborted) return;
          } catch { if (done || signal.aborted) return; message = '登录成功，但密码未能保存；请检查系统凭据库后重试。'; await push(); finish(); return; }
        }
        message = context.record?.rememberPassword && !context.candidate && !context.record.credential
          ? '登录成功。此登录页面不支持安全记住密码，下次仍需手动登录。' : '登录成功，可以返回 Codex。';
        await push(); finish();
      } catch {
        // A guest-session probe can finish after the browser has reached SSO.
        // Do not turn this expected pre-login state into a spurious error.
        if (!done && !contents.isDestroyed() && !contents.isLoadingMainFrame() &&
            new URL(contents.getURL()).origin === p[platform]) {
          message = '等待学校完成登录验证…'; await push();
        }
      }
      finally { validating = false; }
    };
    const timer = setInterval(() => { void check().catch(() => {}); }, 1200);
    // Let the institution's root route to its configured SSO/landing page.
    void contents.loadURL(`${p[platform]}/`).catch(() => {
      if (done || signal.aborted || contents.isDestroyed()) return;
      // Electron can reject loadURL with ERR_ABORTED when the LMS immediately
      // redirects to its IdP. The redirected page is already usable.
      const current = contents.getURL();
      if (allowedNavigation(current)) { loginUrl = loginPage(current) ?? loginUrl; void push(); return; }
      message = '学校页面加载失败，请取消后重试。'; void push();
    });
  });
}
async function start(profileId: string, selection: string) {
  if (busy) return;
  if (fromProfile && profileId !== fromProfile) throw new Error('Profile does not match the requested authorization');
  if (fromProfile && arg('--platform') && arg('--platform') !== 'all' && selection !== arg('--platform')) throw new Error('Platform does not match the requested authorization');
  busy = true; abort = new AbortController();
  const sessions: Array<{ platform: PlatformType; store: ElectronSession }> = [];
  const timeout = setTimeout(() => abort?.abort(), 15 * 60_000);
  let success = false;
  let activeProfile: Profile | undefined;
  try {
    const p = await getProfile(profileId);
    activeProfile = p;
    const selected = selection === 'all' ? platforms(p) : [Platform.parse(selection)];
    if (selected.some(s => !p[s])) throw new Error('Platform missing');
    abort.signal.throwIfAborted();
    activeLogin = { profile: p, platforms: selected, automationStopped: false };
    let completed = 0;
    for (const platform of selected) {
      abort.signal.throwIfAborted();
      currentPlatform = platform; loginUrl = p[platform]!;
      const pref = preferences[p.id]?.[platform];
      if (backgroundLogin && !(pref?.rememberPassword && pref.autoLogin && pref.hasPassword)) continue;
      message = pref?.autoLogin && pref.hasPassword ? '正在准备自动登录，可取消或关闭自动登录' : '请在下方学校页面登录';
      if (!pref?.rememberPassword) await clearPersistentPartition(p.id, platform);
      // Use the stable partition during the attempt so enabling remember-
      // password after the page opens can retain the trusted-device cookie.
      // The partition is cleared in finally when consent is not enabled.
      const store = session.fromPartition(persistentPartition(p.id, platform));
      sessions.push({ platform, store });
      store.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      store.setPermissionCheckHandler(() => false);
      store.on('will-download', event => event.preventDefault());
      await push();
      const signal = backgroundLogin ? AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]) : abort.signal;
      try { await authorize(p, platform, store, signal); completed++; }
      catch (error) { if (!backgroundLogin || abort.signal.aborted) throw error; }
    }
    success = completed === selected.length;
  } catch { message = abort?.signal.aborted ? '已取消本次登录。' : '登录未完成，请重试。'; }
  finally {
    clearTimeout(timeout); abort?.abort(); activeLogin = undefined; currentPlatform = undefined; loginUrl = '';
    try {
      for (const { platform, store } of sessions) if (!activeProfile || !preferences[activeProfile.id]?.[platform]?.rememberPassword) { await store.clearStorageData(); await store.clearCache(); }
    }
    finally { busy = false; await push(); }
  }
  if (fromCLI) app.exit(success ? 0 : 2);
}

app.on('window-all-closed', () => { abort?.abort(); app.exit(busy ? 2 : 0); });

// Do not use top-level `await app.whenReady()` here. Electron emits the ready
// event only after the main module returns to its event loop; awaiting it while
// evaluating the entry module can deadlock the packaged app before any window
// exists (the process remains alive but appears to flicker or do nothing).
async function boot() {
  await app.whenReady();
  const config = await loadConfig();
  for (const p of config.profiles) for (const platform of platforms(p)) {
    try { (preferences[p.id] ??= {})[platform] = loginSummary(await loginStore.read(p, platform), await loginStore.readTotp(p, platform)); }
    catch { message = '无法读取已保存的登录选项，请检查系统凭据库。'; }
  }
  controller = new BrowserWindow({ show: false, focusable: !backgroundLogin, width: directLogin ? 1040 : 480, height: directLogin ? 780 : 460, minWidth: 420, minHeight: 320, useContentSize: true, title: 'lms-cli', webPreferences: { disableDialogs: backgroundLogin, backgroundThrottling: !backgroundLogin, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  controller.center();
  controller.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controller.webContents.on('will-navigate', e => e.preventDefault());
  controller.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); cancelLogin(); }
  });
  controller.on('close', () => { abort?.abort(); for (const w of BrowserWindow.getAllWindows()) if (w !== controller) w.destroy(); });
  ipcMain.handle('lms:state', e => { if (e.sender !== controller.webContents) throw new Error(); return push(); });
  ipcMain.handle('lms:login', (e, id, platform) => { if (e.sender !== controller.webContents) throw new Error(); void start(id, platform).catch(() => { message = '无法开始登录，请重试。'; void push(); }); });
  ipcMain.handle('lms:cancel-login', e => {
    if (e.sender !== controller.webContents || e.senderFrame !== controller.webContents.mainFrame) throw new Error('Not authorized');
    cancelLogin();
    return push();
  });
  ipcMain.handle('lms:stop-auto', async e => {
    if (e.sender !== controller.webContents || e.senderFrame !== controller.webContents.mainFrame) throw new Error('Not authorized');
    const active = activeLogin;
    if (!active) return push();
    stopAutomation(); // Synchronous revocation before any keychain/disk awaits.
    try {
      for (const platform of active.platforms) {
        const saved = await loginStore.read(active.profile, platform);
        if (saved) (preferences[active.profile.id] ??= {})[platform] = await loginStore.setOptions(active.profile, platform, { rememberPassword: true, autoLogin: false });
      }
      if (activeLogin === active) message = '自动登录已关闭，可在学校窗口继续手动登录。';
    } catch { if (activeLogin === active) message = '本次自动登录已停止，但设置未能保存；请检查系统凭据库后重试。'; }
    return push();
  });
  ipcMain.handle('lms:login-options', async (e, id, selection, input) => {
    if (e.sender !== controller.webContents || e.senderFrame !== controller.webContents.mainFrame || optionsSaving || (fromProfile && id !== fromProfile)) throw new Error('Login options unavailable');
    if (fromProfile && arg('--platform') && arg('--platform') !== 'all' && selection !== arg('--platform')) throw new Error('Platform does not match the requested authorization');
    if (busy && (activeLogin?.profile.id !== id || selection !== currentPlatform)) throw new Error('Active login does not match');
    const options = LoginOptions.parse(input);
    const active = activeLogin;
    const previous = new Map([...new Set(loginWindows.values())].map(context => [context, context.record]));
    // Capture consent/revoke automation synchronously, even while vault I/O waits.
    if (busy && !options.autoLogin) stopAutomation();
    for (const context of previous.keys()) context.updateOptions(options);
    optionsSaving = true;
    const save = (async () => {
      try {
        const p = active?.profile ?? await getProfile(id);
        const selected = selection === 'all' ? platforms(p) : [Platform.parse(selection)];
        if (selected.some(platform => !p[platform])) throw new Error();
        for (const platform of selected) {
          (preferences[p.id] ??= {})[platform] = await loginStore.setOptions(p, platform, options);
          if (!options.rememberPassword) await clearPersistentPartition(p.id, platform);
        }
        const ready = selected.every(platform => preferences[p.id]?.[platform]?.hasPassword);
        if (activeLogin === active) message = !options.rememberPassword ? '不再保存密码，自动登录已关闭'
          : !ready ? '完成本次学校登录后，才会安全保存密码'
          : options.autoLogin ? '已开启，下次将自动登录' : '仅记住密码，由你点击登录';
      } catch {
        stopAutomation();
        for (const [context, record] of previous) if (context.contents.size) { context.record = record; if (!record) context.candidate = undefined; }
        throw new Error('无法保存登录选项，请检查系统凭据库后重试。');
      } finally { optionsSaving = false; }
    })();
    optionsPending = save.then(() => {}, () => {});
    await save; return push();
  });
  ipcMain.on('lms:login-capture', (event, input) => {
    const sender = loginSender(event);
    sender?.context.capture(sender.page, input);
  });
  ipcMain.on('lms:login-capture-step', (event, input) => {
    const sender = loginSender(event);
    sender?.context.captureStep(sender.page, input);
  });
  ipcMain.on('lms:login-progress', (event, form, phase) => {
    const sender = loginSender(event);
    const credential = sender?.context.record?.credential;
    if (!sender || !credential || !['filled', 'manual', 'step-filled', 'step-manual', 'otp-filled', 'otp-manual'].includes(phase)) return;
    const passwordProgress = matchesLoginForm(credential, form) && sender.page === credential.form.page;
    const stepProgress = phase.startsWith('step-') && sender.context.canSubmitStep(sender.page, form);
    const otpProgress = phase.startsWith('otp-') && sender.context.canSubmitOtp(sender.page, form);
    if (!passwordProgress && !stepProgress && !otpProgress) return;
    if (phase === 'manual' || phase === 'step-manual' || phase === 'otp-manual') sender.context.stopAutomation();
    message = phase === 'manual' ? '自动登录已停止，请在学校页面手动继续'
      : phase === 'step-manual' ? '分步自动登录已停止，请在学校页面手动继续'
      : phase === 'otp-manual' ? '自动验证码已停止，请在学校页面手动继续'
      : phase === 'otp-filled' ? '已填入一次性验证码，2 秒后自动提交；可取消'
      : phase === 'step-filled' ? '已填入分步登录信息，2 秒后自动提交；可取消'
      : sender.context.canSubmit(sender.page, form) ? '已填入账号密码，2 秒后自动登录；可取消'
      : '已填入账号密码，请点击学校的登录按钮';
    void push();
  });
  ipcMain.handle('lms:login-fill', (event, form) => {
    const sender = loginSender(event);
    return sender?.context.fill(sender.page, form) ?? null;
  });
  ipcMain.handle('lms:login-submit', (event, form) => {
    const sender = loginSender(event);
    return sender ? (sender.context.canSubmit(sender.page, form) || sender.context.canSubmitStep(sender.page, form)) : false;
  });
  ipcMain.handle('lms:login-otp-fill', (event, form) => {
    const sender = loginSender(event);
    return sender?.context.fillOtp(sender.page, form) ?? null;
  });
  ipcMain.handle('lms:login-otp-submit', (event, form) => {
    const sender = loginSender(event);
    return sender?.context.canSubmitOtp(sender.page, form) ?? false;
  });
  await controller.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(authorizationHTML())}`);
  if (!backgroundLogin) { controller.show(); controller.focus(); controller.moveTop(); }
  const initial = config.profiles.find(p => p.id === (fromProfile ?? config.active));
  const selection = fromProfile ? arg('--platform') ?? 'all' : 'all';
  const selected = initial ? (selection === 'all' ? platforms(initial) : [Platform.parse(selection)]) : [];
  if (!initial && backgroundLogin) { app.exit(2); return; }
  if (initial && (fromProfile || canRestoreLogin(selected, preferences[initial.id])))
    void start(initial.id, selection).catch(() => { message = '未能打开已保存的登录，请点击开始登录重试。'; void push(); });
}

void boot().catch(() => { app.exit(1); });
