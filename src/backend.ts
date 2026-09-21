import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getProfile, platforms, type Platform, type Profile } from './config.js';
import { vault } from './vault.js';
import { isAllowed, platformFor } from './policy.js';
import { LmsError, publicError } from './errors.js';
import { VERSION } from './version.js';
import { getPlatform, isPlatformEnvironment, toolPlatform } from './platforms/registry.js';
import { planOverview } from './platforms/overview.js';
import type { ReadCall } from './platforms/types.js';

export interface Connection { tools: Tool[]; call(name: string, args: Record<string, unknown>): Promise<CallToolResult>; close(): Promise<void>; }
export type Connect = (p: Profile, platform: Platform) => Promise<Connection>;
const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));

export const connectUpstream: Connect = async (p, platform) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !isPlatformEnvironment(key)) env[key] = value;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const transport = new StdioClientTransport({ command: process.execPath, args: [workerPath, platform, p.id], env, stderr: 'pipe' });
  const client = new Client({ name: 'lms-cli', version: VERSION });
  transport.stderr?.on('data', () => {}); // Upstream diagnostic bodies are intentionally not logged.
  try {
    await client.connect(transport, { timeout: 15_000 });
    const { tools } = await client.listTools();
    return { tools: tools.filter(t => isAllowed(t.name, platform)), call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 }) as Promise<CallToolResult>, close: () => client.close() };
  } catch { await client.close().catch(() => {}); throw new LmsError('CONNECTOR_UNAVAILABLE', `${platform} connector did not start.`, 'Run lms doctor. Reinstall the package if its built files are missing.'); }
};

type Entry = { generation: string | null; connection: Promise<Connection> };
export interface ReadResult {
  ok: boolean; profile: string; platform: Platform | null; tool: string; origin: string; timezone: string;
  fetchedAt: string; cached: boolean; elapsedMs: number; coverage: string; data?: CallToolResult;
  error?: ReturnType<typeof publicError>;
}
export class Backend {
  private connections = new Map<string, Entry>();
  private cache = new Map<string, ReadResult>();
  private inFlight = new Map<string, Promise<ReadResult>>();
  constructor(private connect: Connect = connectUpstream, private generation: (p: Profile, s: Platform) => Promise<string | null> = (p, s) => vault.generation(p, s)) {}
  private async connection(p: Profile, platform: Platform) {
    if (!p[platform]) throw new LmsError('NOT_CONFIGURED', `${platform} is not configured in profile ${p.id}.`);
    const key = JSON.stringify([p.id, platform, p[platform]]); const generation = await this.generation(p, platform);
    const old = this.connections.get(key);
    if (old?.generation === generation) return old.connection;
    // Publish the replacement promise before awaiting old-process shutdown. Concurrent
    // reads after a login must share one replacement, not race to start orphan workers.
    const connection = (async () => {
      if (old) await old.connection.then(c => c.close()).catch(() => {});
      return this.connect(p, platform);
    })();
    const entry = { generation, connection };
    this.connections.set(key, entry);
    connection.catch(() => { if (this.connections.get(key) === entry) this.connections.delete(key); });
    return connection;
  }
  async catalog(p: Profile, options: { platform?: Platform; query?: string; name?: string } = {}) {
    const selected = options.name ? [platformFor(options.name)] : options.platform ? [options.platform] : platforms(p);
    const results = await Promise.all(selected.map(async s => ({ platform: s, tools: (await this.connection(p, s)).tools.filter(tool => isAllowed(tool.name, s)) })));
    const found = results.flatMap(({ platform, tools }) => tools.filter(t => (!options.name || t.name === options.name) && (!options.query || `${t.name} ${t.description}`.toLowerCase().includes(options.query.toLowerCase()))).map(t => ({ platform, name: t.name, description: t.description, ...(options.name ? { inputSchema: t.inputSchema } : {}) })));
    if (options.name && !found.length) throw new LmsError('TOOL_NOT_FOUND', 'Tool unavailable in this connector version.');
    return found;
  }
  async call(p: Profile, name: string, args: Record<string, unknown> = {}, options: { fresh?: boolean } = {}): Promise<ReadResult> {
    const platform = platformFor(name); const started = Date.now();
    const origin = p[platform] ?? '';
    const base = { ok: false, profile: p.id, platform, tool: name, origin, timezone: p.timezone, fetchedAt: new Date().toISOString(), cached: false, elapsedMs: 0, coverage: 'Bounded upstream response, not a complete account export. Check pagination, truncation and per-course failures in data.' };
    try {
      const client = await this.connection(p, platform); const tool = client.tools.find(t => t.name === name);
      if (!tool) throw new LmsError('TOOL_NOT_FOUND', 'Tool unavailable.');
      const checker = validate.compile({ ...tool.inputSchema, additionalProperties: false });
      if (!checker(args)) throw new LmsError('BAD_INPUT', checker.errors?.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ') ?? 'Invalid arguments', `Use lms tools --name ${name} for its schema.`);
      const generation = await this.generation(p, platform);
      if (!generation) throw new LmsError('AUTH_REQUIRED', `Sign in to ${platform}.`, `Run lms auth login --profile ${p.id} --platform ${platform}.`);
      const key = createHash('sha256').update(JSON.stringify([p, generation, name, args])).digest('hex');
      const cached = this.cache.get(key);
      if (!options.fresh && cached && Date.now() - Date.parse(cached.fetchedAt) < 60_000) return { ...cached, cached: true, elapsedMs: Date.now() - started };
      const running = this.inFlight.get(key); if (running) return running;
      const read = (async () => {
        let data: CallToolResult;
        try { data = await client.call(name, args); }
        catch { throw new LmsError('UPSTREAM_TIMEOUT_OR_PROTOCOL', 'The connector timed out or returned an invalid response.', 'Retry a narrower query. No empty-success result or stale fallback was substituted.'); }
        if (await this.generation(p, platform) !== generation) throw new LmsError('SESSION_CHANGED', 'Authorization changed during the request; retry with the new session.');
        if (data.isError) {
          const diagnostic = data.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
          if (/SESSION_EXPIRED|NOT_AUTHENTICATED|expired|redirected|credentials|AUTH_REQUIRED|\b401\b/i.test(diagnostic)) throw new LmsError('AUTH_REQUIRED', `${platform} requires authorization.`, `Run lms auth login --profile ${p.id} --platform ${platform}.`);
          if (/FORBIDDEN|\b403\b/i.test(diagnostic)) throw new LmsError('FORBIDDEN', 'The platform denied access to this resource.');
          if (/NOT_FOUND|\b404\b/i.test(diagnostic)) throw new LmsError('NOT_FOUND', 'The platform could not find this resource.');
          throw new LmsError('UPSTREAM_FAILED', 'The platform request failed. This is not an empty result.', 'Check scope and IDs; try a smaller request or reauthorize.');
        }
        const result: ReadResult = { ...base, ok: true, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - started, data };
        // Memory-only response caching; never persist raw course data or auth errors in logs.
        if (Buffer.byteLength(JSON.stringify(data)) <= 1_000_000) {
          this.cache.set(key, result); if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!);
        }
        return result;
      })();
      this.inFlight.set(key, read);
      try { return await read; } finally { this.inFlight.delete(key); }
    } catch (e) { return { ...base, elapsedMs: Date.now() - started, error: publicError(e) }; }
  }
  async batch(p: Profile, calls: ReadCall[], fresh = false) {
    if (!calls.length || calls.length > 8) throw new LmsError('BAD_INPUT', 'Batch must contain 1–8 calls.');
    return this.readMany(p, calls, fresh);
  }
  private async readMany(p: Profile, calls: ReadCall[], fresh: boolean) {
    const results: ReadResult[] = new Array(calls.length); let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, calls.length) }, async () => {
      while (index < calls.length) { const i = index++; const c = calls[i]!;
        try { results[i] = await this.call(p, c.tool, c.args ?? {}, { fresh }); }
        catch (e) { results[i] = { ok: false, profile: p.id, platform: toolPlatform(c.tool) ?? null, tool: c.tool, origin: '', timezone: p.timezone, fetchedAt: new Date().toISOString(), cached: false, elapsedMs: 0, coverage: 'Not read', error: publicError(e) }; }
      }
    }));
    return { ok: results.every(r => r.ok), partial: results.some(r => !r.ok), results };
  }
  async overview(p: Profile, days = 14, fresh = false) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new LmsError('BAD_INPUT', 'days must be between 1 and 90.');
    const plan = planOverview(platforms(p).map(getPlatform), days);
    const result = await this.readMany(p, plan.calls, fresh);
    return { ...result, ok: result.ok && !plan.unsupportedPlatforms.length, partial: result.partial || !!plan.unsupportedPlatforms.length, scope: plan.scope, unsupportedPlatforms: plan.unsupportedPlatforms, note: 'Fast evidence collection, not a generated timetable. Announcements can override API due dates. Follow relevant links, verify applicability, and report coverage gaps.' };
  }
  async check(p: Profile, platform?: Platform) {
    const selected = platform ? [platform] : platforms(p);
    if (selected.some(s => !p[s])) throw new LmsError('NOT_CONFIGURED', 'That platform is not configured for this profile.');
    const checks = selected.flatMap(s => { const { probes } = getPlatform(s); return [probes.identity, probes.courses]; });
    const result = await this.readMany(p, checks, true);
    return { ok: result.ok, partial: result.partial, profile: p.id, label: p.label, timezone: p.timezone,
      checks: result.results.map(({ tool, origin, ok, fetchedAt, error }) => ({ platform: platformFor(tool), tool, origin, ok, fetchedAt, ...(error ? { error } : {}) })),
      limitations: Object.fromEntries(selected.map(s => [s, getPlatform(s).limitations])),
      note: 'Live identity and course-list probes only; no private response bodies are included. Success does not verify announcements, assignments, grades, files, all courses or other schools. See platform limitations.' };
  }
  async close() { await Promise.all([...this.connections.values()].map(e => e.connection.then(c => c.close()).catch(() => {}))); this.connections.clear(); this.cache.clear(); }
}
export async function withBackend<T>(id: string | undefined, fn: (backend: Backend, profile: Profile) => Promise<T>) {
  const b = new Backend(); try { return await fn(b, await getProfile(id)); } finally { await b.close(); }
}
