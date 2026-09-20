// Offline Chromium smoke test; never opens a school URL or reads real configuration.
// Run after build: npx electron scripts/verify-auth-ui.mjs
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { authorizationHTML } from '../dist/src/auth/ui.js';

app.whenReady().then(async () => {
  const state = { active: 'example', profiles: [
    { id: 'example', label: '示例大学 · 主账号', timezone: 'Asia/Hong_Kong', canvas: 'https://canvas.example.edu' },
    { id: 'exchange', label: '交换学校 · 研究账号', timezone: 'Europe/London', canvas: 'https://exchange.example.edu', blackboard: 'https://learn.example.edu' },
  ] };
  const win = new BrowserWindow({ show: false, width: 500, height: 740, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  const html = authorizationHTML().replace(/(<script nonce="[^"]+">)/, `$1window.lms={state:async()=>(${JSON.stringify(state)}),onState:fn=>{window.pushState=fn},login:async(...args)=>{window.loginArgs=args}};`);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const inspect = () => win.webContents.executeJavaScript(`({title:document.title,school:document.getElementById('school').value,platforms:Array.from(document.getElementById('platform').options,o=>o.value),disabled:document.getElementById('school').disabled,loginDisabled:document.getElementById('login').disabled,overflow:document.documentElement.scrollHeight>innerHeight})`);
  let actual = await inspect();
  assert.equal(actual.title, 'lms-cli'); assert.equal(actual.school, 'example'); assert.deepEqual(actual.platforms, ['canvas']);
  await win.webContents.executeJavaScript(`document.getElementById('school').value='exchange';document.getElementById('school').dispatchEvent(new Event('change'));`);
  actual = await inspect(); assert.equal(actual.school, 'exchange'); assert.deepEqual(actual.platforms, ['all', 'canvas', 'blackboard']); assert.equal(actual.overflow, false);
  if (process.env.LMS_UI_SCREENSHOT) await writeFile(process.env.LMS_UI_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById('platform').value='blackboard';document.getElementById('login').click();`);
  assert.deepEqual(await win.webContents.executeJavaScript('window.loginArgs'), ['exchange', 'blackboard']);
  assert.equal((await inspect()).disabled, true);
  const hostile = { ...state, lockedProfile: 'example', profiles: [{ ...state.profiles[0], label: '</script><img src=x onerror="window.injected=true">' }] };
  await win.webContents.executeJavaScript(`window.pushState(${JSON.stringify(hostile)})`);
  actual = await inspect(); assert.equal(actual.school, 'example'); assert.equal(actual.disabled, true);
  assert.equal(await win.webContents.executeJavaScript('document.images.length'), 0);
  await win.webContents.executeJavaScript('window.pushState({profiles:[]})'); assert.equal((await inspect()).loginDisabled, true);
  console.log('Electron authorization UI smoke test passed (synthetic schools, no network).');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
