// Vector source is the canonical brand asset. Run: npx electron scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, webPreferences: { sandbox: true, offscreen: true } });
  const svg = await readFile(new URL('../assets/lms-icon.svg', import.meta.url), 'utf8');
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 }).toPNG();
  await writeFile(new URL('../assets/lms-icon.png', import.meta.url), png);
  await writeFile(new URL('../plugins/lms-cli/assets/lms-icon.png', import.meta.url), png);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
