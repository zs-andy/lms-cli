import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizationHTML } from '../src/auth/ui.js';
import { runInNewContext } from 'node:vm';
import type { Profile } from '../src/config.js';

test('authorization page uses the lms-cli brand, school selection and a fresh CSP nonce', () => {
  const html = authorizationHTML();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const visible = html.replace(/<style>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  assert.deepEqual([...new Set(css.match(/#[\da-f]{3,8}\b/gi))].sort(), ['#000', '#fff']);
  assert.match(visible, /lms-cli/);
  assert.match(visible, /开始登录/);
  assert.doesNotMatch(visible, /PolyU|cookie|token/i);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.equal((html.match(/<select\b/g) ?? []).length, 2);
  assert.match(html, /role="status"/);
  assert.match(html, /window\.lms\.login\(school\.value,platform\.value\)/);
  assert.notEqual(html, authorizationHTML(), 'Each page must receive a fresh script nonce');
});

test('plugin, package and marketplace consistently use lms-cli with neutral icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/lms-cli/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  for (const slot of ['composerIcon', 'logo', 'logoDark']) assert.equal(manifest.interface[slot], './assets/lms-icon.png');
  assert.equal(manifest.interface.displayName, 'lms-cli');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const market = JSON.parse(await readFile(new URL('../.agents/plugins/marketplace.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'lms-cli'); assert.equal(pkg.build.productName, 'lms-cli');
  assert.equal(market.name, 'lms-cli'); assert.equal(market.interface.displayName, 'lms-cli');
  assert.equal(manifest.version, pkg.version);
  const png = await readFile(new URL('../plugins/lms-cli/assets/lms-icon.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

type State = { profiles: Profile[]; active?: string; lockedProfile?: string; busy?: boolean; message?: string };
class Element {
  children: Element[] = []; textContent = ''; disabled = false; hidden = false;
  onclick?: () => Promise<void>; onchange?: () => void; private current = '';
  constructor(private select = false) {}
  get value() { return this.current; }
  set value(value: string) { this.current = !this.select || this.children.some(c => c.value === value) ? value : ''; }
  replaceChildren(...children: Element[]) { this.children = children; if (this.select) this.current = children[0]?.value ?? ''; }
  set innerHTML(_value: string) { throw new Error('Profile data must never be rendered as HTML'); }
}
async function page(initial: State, failLogin = false) {
  const elements = Object.fromEntries(['school', 'platform', 'origins', 'status', 'login', 'setup'].map(id => [id, new Element(['school', 'platform'].includes(id))])) as Record<string, Element>;
  const calls: string[][] = []; let update!: (state: State) => void;
  const html = authorizationHTML();
  runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: (id: string) => elements[id], createElement: () => new Element() },
    window: { lms: { state: async () => initial, onState: (fn: typeof update) => { update = fn; }, login: async (...args: string[]) => { if (failLogin) throw new Error('offline'); calls.push(args); } } },
  });
  await Promise.resolve();
  return { elements, calls, update };
}
const a: Profile = { id: 'alpha', label: 'Alpha', timezone: 'Europe/London', canvas: 'https://alpha.instructure.com' };
const b: Profile = { id: 'beta', label: '<img src=x onerror=alert(1)>', timezone: 'America/New_York', blackboard: 'https://learn.beta.edu' };
test('school switching filters platforms and sends the selected profile, not PolyU', async () => {
  const { elements: el, calls } = await page({ profiles: [a, b], active: a.id });
  assert.equal(el.school!.value, 'alpha'); assert.equal(el.platform!.value, 'canvas');
  assert.equal(el.platform!.children.length, 1);
  el.school!.value = 'beta'; el.school!.onchange!();
  assert.equal(el.platform!.value, 'blackboard'); assert.equal(el.platform!.children.length, 1);
  assert.equal(el.school!.children[1]!.textContent, `${b.label} (beta)`);
  assert.equal(el.origins!.textContent, 'Blackboard: https://learn.beta.edu');
  await el.login!.onclick!(); assert.deepEqual(calls, [['beta', 'blackboard']]);
  assert.equal(el.school!.disabled, true); assert.equal(el.platform!.disabled, true);
});
test('empty state, dual-platform selection and locked authorization jobs', async () => {
  const { elements: el, update } = await page({ profiles: [] });
  assert.equal(el.login!.disabled, true); assert.equal(el.setup!.hidden, false);
  const dual = { ...a, blackboard: 'https://learn.alpha.edu' };
  update({ profiles: [dual, b], active: b.id, lockedProfile: a.id });
  assert.equal(el.school!.value, a.id); assert.equal(el.school!.disabled, true);
  assert.equal(el.platform!.value, 'all'); assert.equal(el.platform!.children.length, 3);
  assert.equal(el.setup!.hidden, true); assert.equal(el.login!.disabled, false);
  update({ profiles: [dual, b], lockedProfile: 'missing' });
  assert.equal(el.login!.disabled, true);
});
test('failed launch allows retry without changing schools', async () => {
  const { elements: el } = await page({ profiles: [b], active: b.id }, true);
  await el.login!.onclick!(); assert.equal(el.login!.disabled, false); assert.equal(el.school!.value, b.id);
});
