import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Backend } from '../dist/src/backend.js';
import { addProfile, polyu } from '../dist/src/config.js';
const home = await mkdtemp(join(tmpdir(), 'lms-integration-')); process.env.LMS_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
await addProfile(polyu);
test('real upstream MCP handshakes work offline and expose reviewed schemas', async () => {
  const b = new Backend();
  try {
    const catalog = await b.catalog(polyu); assert(catalog.length >= 50);
    assert(!catalog.some(t => /submit|save_quiz|start_quiz|raw_request|batch_request/.test(t.name)));
    const announcement = await b.catalog(polyu, { name: 'bb_announcements' }); assert(announcement[0]!.inputSchema);
    const result = await b.call(polyu, 'canvas_list_courses'); assert.equal(result.error?.code, 'AUTH_REQUIRED');
    // Every precomposed overview argument must pass the actual upstream schema.
    const overview = await b.overview(polyu, 14); assert(overview.partial); assert.equal(overview.results.length, 8);
    assert(overview.results.every(r => r.error?.code === 'AUTH_REQUIRED'), JSON.stringify(overview.results.map(r => ({ tool: r.tool, error: r.error }))));
  } finally { await b.close(); }
});
test('public MCP server handles discovery, denied writes, profile listing and shutdown', async () => {
  const client = new Client({ name: 'acceptance-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'mcp'], env: { ...process.env as Record<string, string>, LMS_HOME: home }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport); const tools = (await client.listTools()).tools; assert.equal(tools.length, 11);
    assert(!tools.some(t => t.name === 'lms_profile_add'));
    const profiles = await client.callTool({ name: 'lms_profiles', arguments: {} }); assert.equal(profiles.isError, false);
    const denied = await client.callTool({ name: 'lms_call', arguments: { tool: 'bb_submit_assignment', args: {} } }); assert.equal(denied.isError, true);
  } finally { await client.close(); }
});
test('CLI failure exit codes and JSON stay machine-readable', () => {
  const cli = fileURLToPath(new URL('../bin/lms.js', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LMS_HOME: home }, timeout: 30000 });
  const doctor = run(['doctor']); assert.equal(doctor.status, 0); assert.equal(JSON.parse(doctor.stdout).readOnly, true);
  const invalid = run(['call', 'bb_raw_request']); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).error.code, 'TOOL_NOT_ALLOWED');
  const missing = run(['canvas', 'courses']); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stdout).error.code, 'AUTH_REQUIRED');
  const profilesHelp = run(['profiles', '--help']); assert.equal(profilesHelp.status, 0); assert(!/\badd\b/.test(profilesHelp.stdout));
  const otherSchool = run(['init', '--preset', 'other']); assert.equal(otherSchool.status, 1); assert.equal(JSON.parse(otherSchool.stdout).error.code, 'BAD_INPUT');
});
