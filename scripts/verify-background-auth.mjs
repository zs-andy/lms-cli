// Synthetic authorization through the real app entry, preload and SSO popup handler.
// No school network, real configuration, credentials or OS keyring access.
import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const scenario = process.env.LMS_BACKGROUND_TEST ?? 'success';
assert(['success', 'no-consent', 'timeout', 'partial'].includes(scenario));
const home = mkdtempSync(join(tmpdir(), 'lms-background-'));
process.env.LMS_HOME = home;
process.env.LMS_AUTH_BACKGROUND = '1';
app.setPath('userData', join(home, 'chromium'));
const moduleURL = name => new URL('../dist/src/' + name + '.js', import.meta.url).href;
const profile = { id: 'fixture', label: 'Synthetic school', timezone: 'UTC', blackboard: 'https://learn.example.invalid',
  ...(scenario === 'partial' ? { canvas: 'https://canvas.example.invalid' } : {}) };
let shown = 0, focused = 0, popups = 0, submissions = 0, hook;
const memory = new Map();
const exit = app.exit.bind(app);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 240; i++) { if (await check()) return; await delay(25); }
  throw new Error('Timed out: ' + label);
}
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => shown++); window.on('focus', () => focused++);
});
app.on('session-created', store => {
  store.protocol.handle('https', request => {
    if (new URL(request.url).pathname === '/popup') return new Response('<p>Synthetic SSO child</p>', { headers: { 'content-type': 'text/html' } });
    return new Response(`<!doctype html><form method="post" action="/session"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form><script>document.querySelector('form').addEventListener('submit', e => {e.preventDefault();fetch('/submitted');${scenario === 'timeout' ? '' : "document.cookie='JSESSIONID=synthetic-session; Secure; path=/'"}});</script>`, { headers: { 'content-type': 'text/html' } });
  });
  store.webRequest.onBeforeRequest((details, callback) => { if (new URL(details.url).pathname === '/submitted') submissions++; callback({}); });
});
app.whenReady().then(async () => {
  const { addProfile } = await import(moduleURL('config'));
  const { vault } = await import(moduleURL('vault'));
  vault.read = async (p, slot) => structuredClone(memory.get(p.id + ':' + slot) ?? null);
  vault.write = async (p, slot, value) => { memory.set(p.id + ':' + slot, { generation: 'test', value: structuredClone(value) }); return 'test'; };
  vault.remove = async (p, slot) => { memory.delete(p.id + ':' + slot); };
  for (const platform of ['canvas', 'blackboard']) if (profile[platform]) {
    memory.set('fixture:login:' + platform, { generation: 'test', value: {
      version: 1, rememberPassword: true, autoLogin: scenario !== 'no-consent',
      credential: { username: 'synthetic-user', password: 'synthetic-not-real', form: {
        page: profile[platform] + '/', action: profile[platform] + '/session', usernameField: 'username', passwordField: 'password',
      } },
    } });
  }
  await addProfile(profile);
  hook = registerHooks({ load(url, context, next) {
    if (url === moduleURL('auth/validate')) return { format: 'module', shortCircuit: true, source: 'import { vault } from ' + JSON.stringify(moduleURL('vault')) + '; export async function validateInWorker(p,platform,candidate,signal){signal.throwIfAborted();const validatedAt=new Date().toISOString();await vault.write(p,platform,{...candidate,validatedAt});return {ok:true,platform,validatedAt};}' };
    return next(url, context);
  } });
  // Exercise the production timeout/abort path without waiting 45 seconds.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  if (scenario === 'timeout' || scenario === 'partial') {
    let calls = 0;
    AbortSignal.timeout = ms => timeout(++calls === 1 ? 250 : ms);
  }
  const exits = []; app.exit = code => exits.push(code);
  process.argv.push('--from-cli', '--profile', profile.id, '--platform', 'all');
  await import(moduleURL('auth/app'));
  if (scenario === 'success') {
    await until(() => BrowserWindow.getAllWindows()[0]?.contentView.children.some(v => v.webContents), 'school view');
    const school = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents).webContents;
    await until(() => school.getURL().startsWith(profile.blackboard), 'synthetic school navigation');
    await school.executeJavaScript("window.open('/popup');void 0", true);
    await until(() => BrowserWindow.getAllWindows().length === 2, 'SSO popup');
    popups++;
    const popup = BrowserWindow.getAllWindows().find(w => w !== BrowserWindow.getAllWindows()[0]);
    assert.equal(popup.isVisible(), false);
    assert.equal(popup.webContents.getLastWebPreferences().disableDialogs, true);
    assert.equal(school.getBackgroundThrottling(), false);
    assert.equal(school.getLastWebPreferences().disableDialogs, true);
  }
  await until(() => exits.length > 0, 'authorization result');
  assert.equal(exits.at(-1), scenario === 'success' ? 0 : 2);
  assert.equal(shown, 0); assert.equal(focused, 0);
  for (const w of BrowserWindow.getAllWindows()) {
    assert.equal(w.isVisible(), false);
    assert.equal(w.contentView.children.length, 0, 'school view closed');
  }
  if (scenario === 'success' || scenario === 'partial') {
    assert(memory.get('fixture:blackboard')?.value.validatedAt, 'successful platform persisted only after validation');
    assert.equal(submissions, 1, 'exactly one automatic form submission');
  } else assert.equal(memory.has('fixture:blackboard'), false);
  if (scenario === 'partial') assert.equal(memory.has('fixture:canvas'), false, 'failed platform not reported as authorized');
  if (scenario === 'no-consent') assert.equal(memory.get('fixture:login:blackboard').value.autoLogin, false, 'consent unchanged');
  if (scenario === 'success') assert.equal(popups, 1);
  hook.deregister();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('Background authorization passed: ' + scenario + '; no visible/focused windows; synthetic data only.');
  exit(0);
}).catch(async error => {
  console.error(error); hook?.deregister();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); exit(1);
});
