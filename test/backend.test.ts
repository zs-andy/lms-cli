import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Backend, type Connect } from '../src/backend.js';
import { polyu, ProfileSchema } from '../src/config.js';
const p = ProfileSchema.parse(polyu);
const tools: Tool[] = [
  { name: 'canvas_list_courses', inputSchema: { type: 'object', properties: {} } },
  { name: 'bb_announcements', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
];
const data = { content: [{ type: 'text' as const, text: '[{"id":1}]' }] };
test('schema validation catches limits and unknown parameters before sending a request', async () => {
  let calls = 0;
  const b = new Backend(async () => ({ tools, call: async () => { calls++; return data; }, close: async () => {} }), async () => 'g1');
  assert.equal((await b.call(p, 'bb_announcements', { limit: 101 })).error?.code, 'BAD_INPUT');
  assert.equal((await b.call(p, 'bb_announcements', { bad: true })).error?.code, 'BAD_INPUT');
  assert.equal(calls, 0); assert.equal((await b.call(p, 'bb_announcements', { limit: 100 })).ok, true); await b.close();
});
test('memory cache and fresh bypass; credential changes invalidate cache and reconnect', async () => {
  let connects = 0; let calls = 0; let closes = 0; let generation: string | null = 'g1';
  const b = new Backend(async () => { connects++; return { tools, call: async () => { calls++; return data; }, close: async () => { closes++; } }; }, async () => generation);
  await b.call(p, 'canvas_list_courses'); assert.equal((await b.call(p, 'canvas_list_courses')).cached, true); assert.equal(calls, 1);
  await b.call(p, 'canvas_list_courses', {}, { fresh: true }); assert.equal(calls, 2);
  generation = 'g2'; assert.equal((await b.call(p, 'canvas_list_courses')).cached, false); assert.equal(connects, 2); assert.equal(closes, 1);
  generation = null; assert.equal((await b.call(p, 'canvas_list_courses')).error?.code, 'AUTH_REQUIRED'); assert.equal(calls, 3); await b.close();
});
test('parallel requests deduplicate startup and identical work', async () => {
  let connects = 0; let calls = 0;
  const b = new Backend(async () => { connects++; await new Promise(r => setTimeout(r, 15)); return { tools, call: async () => { calls++; await new Promise(r => setTimeout(r, 15)); return data; }, close: async () => {} }; }, async () => 'g');
  const results = await Promise.all(Array.from({ length: 8 }, () => b.call(p, 'canvas_list_courses')));
  assert(results.every(r => r.ok)); assert.equal(connects, 1); assert.equal(calls, 1); await b.close();
});
test('batch keeps partial failures explicit and never falls back to empty/stale success', async () => {
  const b = new Backend(async (_p, platform) => ({ tools, call: async () => platform === 'blackboard' ? { isError: true, content: [{ type: 'text', text: 'SESSION_EXPIRED cookie=NEVER-PRINT' }] } : data, close: async () => {} }), async () => 'g');
  const result = await b.batch(p, [{ tool: 'canvas_list_courses' }, { tool: 'bb_announcements' }, { tool: 'bb_submit_assignment' }]);
  assert.equal(result.partial, true); assert.equal(result.ok, false); assert.equal(result.results[0]!.ok, true); assert.equal(result.results[1]!.error?.code, 'AUTH_REQUIRED'); assert.equal(result.results[2]!.error?.code, 'TOOL_NOT_ALLOWED');
  assert(!JSON.stringify(result).includes('NEVER-PRINT')); await b.close();
});
test('failed startup is retryable and batch respects its size bound', async () => {
  let n = 0; const connect: Connect = async () => { if (!n++) throw new Error('startup'); return { tools, call: async () => data, close: async () => {} }; };
  const b = new Backend(connect, async () => 'g'); assert.equal((await b.call(p, 'canvas_list_courses')).ok, false); assert.equal((await b.call(p, 'canvas_list_courses')).ok, true);
  await assert.rejects(b.batch(p, Array.from({ length: 9 }, () => ({ tool: 'canvas_list_courses' })))); await b.close();
});
test('connections and cached results are isolated by school/account and origin', async () => {
  let connects = 0;
  const b = new Backend(async school => { connects++; return { tools, call: async () => ({ content: [{ type: 'text', text: school.canvas! }] }), close: async () => {} }; }, async () => 'same-generation');
  const second = ProfileSchema.parse({ id: 'second', label: 'Second', timezone: 'Europe/London', canvas: 'https://other.instructure.com' });
  const first = await b.call(p, 'canvas_list_courses');
  const other = await b.call(second, 'canvas_list_courses');
  assert.equal(first.origin, p.canvas); assert.equal(other.origin, second.canvas); assert.equal(other.cached, false);
  assert.equal(other.timezone, 'Europe/London'); assert.equal(connects, 2);
  assert.equal((await b.call(p, 'canvas_list_courses')).cached, true);
  const moved = await b.call({ ...second, canvas: 'https://moved.school.edu' }, 'canvas_list_courses');
  assert.equal(connects, 3); assert.equal((moved.data!.content[0] as { text: string }).text, 'https://moved.school.edu');
  await b.close();
});
test('connectivity checks report partial failures, redact bodies and respect configured platforms', async () => {
  const identities: Tool[] = [...tools, { name: 'canvas_get_profile', inputSchema: { type: 'object', properties: {} } }, { name: 'bb_whoami', inputSchema: { type: 'object', properties: {} } }, { name: 'bb_list_courses', inputSchema: { type: 'object', properties: {} } }];
  const b = new Backend(async (_p, platform) => ({ tools: identities, call: async () => platform === 'canvas' ? { content: [{ type: 'text', text: 'PRIVATE-COURSE-BODY' }] } : { isError: true, content: [{ type: 'text', text: '403 forbidden' }] }, close: async () => {} }), async () => 'g');
  const result = await b.check(p); assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.checks.length, 4);
  assert.equal(result.checks[0]!.ok, true); assert.equal(result.checks[2]!.error?.code, 'FORBIDDEN'); assert(!JSON.stringify(result).includes('PRIVATE-COURSE-BODY'));
  const single = { ...p, blackboard: undefined };
  assert.equal((await b.check(single)).checks.length, 2); assert.equal((await b.check(single)).ok, true);
  await assert.rejects(b.check(single, 'blackboard'));
  await b.close();
});
