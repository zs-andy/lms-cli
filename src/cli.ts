#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { addProfile, getProfile, initProfile, loadConfig, Platform, platforms, presets, stateHome, useProfile } from './config.js';
import { VERSION } from './version.js';
import { withBackend } from './backend.js';
import { publicError, LmsError } from './errors.js';
import { aliases, platformFor } from './policy.js';
import { authStatus, startLogin, finishLogin } from './auth/launch.js';
import { vault } from './vault.js';
import { validateInWorker } from './auth/validate.js';
import { exportCalendar, listItems, upsertItems } from './items.js';
import { ask } from './ask.js';

const program = new Command().name('lms').description('lms-cli · multi-school Canvas / Blackboard learning assistant').version(VERSION).option('-p, --profile <id>', 'School/account profile (defaults to the active profile)').option('--json', 'Explicit machine-readable JSON output (default for structured commands)');
const profileId = () => program.opts().profile as string | undefined;
const out = (value: any) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); if (value?.ok === false) process.exitCode = 1; };
const parse = (value: string) => { try { const data = JSON.parse(value); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data as Record<string, unknown>; } catch { throw new LmsError('BAD_INPUT', 'Expected a JSON object.'); } };

const schoolOptions = (command: Command) => command.option('--label <name>', 'School/account display name').option('--timezone <zone>', 'School IANA timezone, e.g. Europe/London').option('--canvas <origin>', 'Canvas HTTPS origin, without a login/course path').option('--blackboard <origin>', 'Blackboard HTTPS origin, without a login/course path');
schoolOptions(program.command('init').description('Create a custom school/account profile or use a preset').option('--preset <name>', 'Optional preset; see lms presets').option('--id <id>', 'Custom profile ID (lowercase letters, digits and hyphens)')).action(async o => out(await initProfile(o)));
program.command('presets').description('List school URL presets; a preset is not a compatibility certification').action(() => out(presets));
const profilesCommand = program.command('profiles').description('Manage school/account configurations; credentials stay isolated');
schoolOptions(profilesCommand.command('add <id>').description('Add a school/account; does not replace an existing profile or change the active profile')).action(async (id, o) => out(await addProfile({ id, ...o })));
profilesCommand.command('list').action(async () => out(await loadConfig()));
profilesCommand.command('use <id>').action(async id => out(await useProfile(id)));

const auth = program.command('auth').description('School authorization for the selected profile');
auth.command('login').option('--platform <name>', 'canvas or blackboard; omit for all').action(async o => {
  const p = await getProfile(profileId()); const job = startLogin(p, o.platform ? Platform.parse(o.platform) : undefined);
  process.stderr.write(`已打开 ${p.label} 的登录窗口，请完成学校登录。完成后会自动继续。\n`);
  const state = await finishLogin(job.id); out({ ok: state === 'finished', state, ...(await authStatus(p)) });
});
auth.command('status').option('--live', 'Validate by a read request, instead of stored metadata only').action(async o => {
  if (!o.live) return out(await authStatus(await getProfile(profileId())));
  const result = await withBackend(profileId(), (b, p) => b.batch(p, platforms(p).map(platform => ({ tool: platform === 'canvas' ? 'canvas_get_profile' : 'bb_whoami' })), true));
  out({ ok: result.ok, results: result.results.map(({ platform, ok, error, fetchedAt }) => ({ platform, ok, error, fetchedAt })) });
});
auth.command('token').description('Import an institution-permitted Canvas token over stdin only').requiredOption('--stdin', 'Read token privately from stdin, not CLI arguments').action(async () => {
  if (process.stdin.isTTY) throw new LmsError('BAD_INPUT', 'Provide the token via a pipe from your password manager; do not put it in shell arguments.');
  let value = ''; for await (const c of process.stdin) { value += c; if (value.length > 16384) throw new LmsError('BAD_INPUT', 'Token is too long.'); }
  out(await validateInWorker(await getProfile(profileId()), 'canvas', { kind: 'token', value: value.trim() }));
});
auth.command('logout').requiredOption('--platform <name>', 'Remove authorization for this platform only').requiredOption('--yes', 'Confirm local credential removal; school session is not remotely revoked').action(async o => { const p = await getProfile(profileId()); const platform = Platform.parse(o.platform); await vault.remove(p, platform); out({ ok: true, profile: p.id, platform, locallySignedOut: true, remoteSessionRevoked: false }); });

program.command('tools').description('Discover tools; pass --name to inspect its exact JSON schema').option('--platform <name>').option('--query <text>').option('--name <tool>').action(async o => out(await withBackend(profileId(), (b, p) => b.catalog(p, { ...o, platform: o.platform ? Platform.parse(o.platform) : undefined }))));
program.command('call <tool>').description('Call an exact, reviewed upstream read tool').option('--args <json>', 'Arguments matching the tool schema', '{}').option('--fresh').action(async (tool, o) => out(await withBackend(profileId(), (b, p) => b.call(p, tool, parse(o.args), o))));
for (const platform of ['canvas', 'blackboard'] as const) {
  program.command(`${platform} <resource>`).description(`Read ${platform} resources. Aliases: ${Object.keys(aliases[platform]).join(', ')}`).option('--course <id>').option('--args <json>', 'Additional exact upstream parameters', '{}').option('--fresh').action(async (resource, o) => {
    const tool = aliases[platform][resource] ?? resource;
    if (platformFor(tool) !== platform) throw new LmsError('BAD_INPUT', 'Tool does not belong to this platform.');
    const args = parse(o.args); if (o.course) args[platform === 'canvas' ? 'course_id' : 'courseId'] = platform === 'canvas' ? Number(o.course) : o.course;
    out(await withBackend(profileId(), (b, p) => b.call(p, tool, args, o)));
  });
}
program.command('overview').description('Bounded evidence for schedules/changes; includes announcements, not only API deadlines').option('--days <n>', 'Look-ahead days', '14').option('--fresh').action(async o => out(await withBackend(profileId(), (b, p) => b.overview(p, Number(o.days), o.fresh))));
program.command('check').description('Live read-only identity/course-list checks; does not certify all features or open login windows').option('--platform <name>', 'canvas or blackboard; defaults to configured platforms').action(async o => out(await withBackend(profileId(), (b, p) => b.check(p, o.platform ? Platform.parse(o.platform) : undefined))));
program.command('ask <question>').description('General natural-language query using your signed-in Codex CLI and the LMS MCP server').option('--model <name>', 'Optional Codex model override').action(async (question, o) => { process.stdout.write(await ask(await getProfile(profileId()), question, o.model)); });
program.command('mcp').description('Serve the general LMS capabilities over MCP stdio').action(async () => { const { serve } = await import('./mcp.js'); await serve(); });
program.command('mcp-config').description('Print portable-install MCP configuration; does not modify any client settings').action(() => out({ mcpServers: { lms: { command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp'], env: { LMS_HOME: stateHome() } } } }));

const items = program.command('items').description('Local source-backed tasks; never writes to the LMS');
items.command('list').action(async () => out(await listItems(await getProfile(profileId()))));
items.command('upsert').requiredOption('--file <json>', 'JSON array of source-backed items').action(async o => out(await upsertItems(await getProfile(profileId()), JSON.parse(await readFile(o.file, 'utf8')))));
items.command('export').requiredOption('--out <ics>', 'New output filename (existing files are not overwritten)').action(async o => { const p = await getProfile(profileId()); const result = exportCalendar(p, await listItems(p)); await writeFile(o.out, result.ics, { flag: 'wx', mode: 0o600 }); out({ ok: true, out: o.out, excluded: result.excluded, note: result.note }); });
program.command('doctor').description('Local diagnostics, without reading or printing credentials').action(async () => {
  let electron = false; let keyringModule = false;
  try { createRequire(import.meta.url).resolve('electron'); electron = true; } catch {}
  try { await import('@napi-rs/keyring'); keyringModule = true; } catch {}
  out({ version: VERSION, node: process.version, os: process.platform, arch: process.arch, stateHome: stateHome(), profiles: (await loadConfig()).profiles.map(p => p.id), authorizationRuntimeInstalled: electron, nativeKeyringModuleLoads: keyringModule, readOnly: true, note: 'Module loading is not an OS keychain or school login test. Use auth login and check for live identity/course-list checks; other features need separate acceptance.' });
});
// Electron RUN_AS_NODE has a Node-shaped argv; Commander's Electron auto-detection
// would otherwise interpret the script path as the command in packaged validators.
try { await program.parseAsync(process.argv, { from: 'node' }); }
catch (e) { out({ ok: false, error: publicError(e) }); process.exitCode = 1; }
