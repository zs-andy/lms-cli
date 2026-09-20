import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizationHTML } from '../src/auth/ui.js';

test('authorization home is monochrome, PolyU-only and user-facing', () => {
  const html = authorizationHTML();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const visible = html.replace(/<style>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  assert.deepEqual([...new Set(css.match(/#[\da-f]{3,8}\b/gi))].sort(), ['#000', '#fff']);
  assert.match(visible, /连接 PolyU/);
  assert.match(visible, /开始登录/);
  assert.doesNotMatch(visible, /cookie|MFA|API|MCP|token|配置|其他学校|系统凭据库/i);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.equal((html.match(/<select\b/g) ?? []).length, 1);
  assert.match(html, /role="status"/);
  assert.match(html, /window\.lms\.login\('polyu',platform\.value\)/);
  assert.notEqual(html, authorizationHTML(), 'Each page must receive a fresh script nonce');
});

test('all plugin icon slots use the pure PolyU emblem', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/lms-cli/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  for (const slot of ['composerIcon', 'logo', 'logoDark']) assert.equal(manifest.interface[slot], './assets/polyu-icon.png');
  assert.equal(manifest.interface.displayName, 'PolyU 学习助手');
});
