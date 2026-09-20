import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasGet, canvasGetPaginated, canvasDownload } from '../vendor/canvas/src/canvas.js';
import { Session } from '../vendor/blackboard/src/auth/session.js';
import { ConfigSchema } from '../vendor/blackboard/src/config.js';
import { HttpClient } from '../vendor/blackboard/src/client/http.js';
process.env.CANVAS_BASE_URL = 'https://school.example.edu';
process.env.CANVAS_API_TOKEN = 'synthetic-test-token';
process.env.CANVAS_NO_KEYCHAIN = '1';

test('Canvas pagination cannot forward credentials off origin', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('[{"id":1}]', { headers: { link: '<https://outside.example.edu/steal>; rel="next"' } }); };
  try { await assert.rejects(canvasGetPaginated('/courses'), /outside the configured HTTPS origin/); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; }
});
test('Canvas file redirect strips credentials before CDN requests', async () => {
  const original = globalThis.fetch; const captured: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => { captured.push(options ?? {}); return captured.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.edu/file' } }) : new Response('file'); };
  try {
    assert.equal((await canvasDownload('https://school.example.edu/file')).toString(), 'file');
    assert.equal((captured[0]!.headers as Record<string, string>).Authorization, 'Bearer synthetic-test-token');
    assert.deepEqual(captured[1]!.headers, {});
    await assert.rejects(canvasDownload('http://school.example.edu/file'), /insecure/);
  } finally { globalThis.fetch = original; }
});
test('Canvas login redirect and HTML are failures, not empty data', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: '/login' } });
    await assert.rejects(canvasGet('/courses'), /expired/);
    globalThis.fetch = async () => new Response('<html>Sign in</html>');
    await assert.rejects(canvasGet('/courses'), /non-JSON/);
  } finally { globalThis.fetch = original; }
});
test('Blackboard read-only guard, HTTPS checks and redirect budget hold at HTTP boundary', async () => {
  const session = await Session.fromCookieHeader('https://learn.example.edu', 'JSESSIONID=synthetic'); session.persist = async () => {};
  const client = new HttpClient(session, ConfigSchema.parse({ baseUrl: session.baseUrl, allowWrites: false }));
  assert.throws(() => client.resolve('http://learn.example.edu/path'));
  assert.throws(() => client.resolve('https://user:secret@learn.example.edu/path'));
  assert.throws(() => client.resolve('https://evil.example.edu/path'));
  await assert.rejects(client.request({ method: 'PATCH', path: '/mutate', retries: 0 }), /disabled/);
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: '/loop' } }); };
  try { await assert.rejects(client.request({ path: '/loop', retries: 0 }), /Too many redirects/); assert.equal(calls, 6); }
  finally { globalThis.fetch = original; }
});
