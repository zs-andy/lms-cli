#!/usr/bin/env node
import { startStdio, SERVER_VERSION } from './server.js';
import { login } from './auth/login.js';
import { discoverProfiles, discoverInstances } from './auth/browsers.js';
import { refreshSession } from './auth/saml.js';
import { importHar } from './auth/har.js';
import { Session, logout } from './auth/session.js';
import { loadConfigOrNull, saveConfig, normaliseBaseUrl } from './config.js';
import { BlackboardClient, displayName, courseLabel } from './client/index.js';
import { HttpClient } from './client/http.js';
import { expand, loadEndpoints, DEFAULT_ENDPOINTS } from './client/endpoints.js';
import { toBlackboardError } from './lib/errors.js';
import { setLogLevel, type LogLevel } from './lib/logger.js';
import { stateDir, downloadDir } from './lib/paths.js';
import { fmtBytes } from './lib/files.js';
import { install, CLIENTS, type ClientId } from './install.js';

/** Writes to stderr: stdout belongs to the JSON-RPC stream. */
const out = (s = ''): void => void process.stderr.write(`${s}\n`);

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [rawKey, inline] = arg.slice(2).split('=');
      const key = (rawKey ?? '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

const HELP = `blackboard-mcp v${SERVER_VERSION}. Blackboard Learn over MCP

USAGE
  blackboard-mcp [serve]                Run the MCP server on stdio (default)
  blackboard-mcp auth login             Sign in (imports from your browser automatically)
  blackboard-mcp auth status            Show session and connectivity status
  blackboard-mcp auth browsers          List browser profiles and Blackboard sessions found
  blackboard-mcp auth refresh           Renew the session now, without signing in
  blackboard-mcp auth logout [--purge]  Forget the session (--purge also drops the key)
  blackboard-mcp har import <file.har>  Learn this tenant's endpoints from a recording
  blackboard-mcp doctor                 Diagnose configuration and connectivity
  blackboard-mcp install [client]       Register with an MCP client
  blackboard-mcp courses                List your courses (quick check)
  blackboard-mcp endpoints [filter]     Show the endpoint map

AUTH LOGIN
  By default this reads the session straight out of your signed-in browser -
  no URLs, no cookies, no DevTools. It also captures your institution's
  identity-provider cookies, which lets the session renew itself silently
  instead of expiring every few hours.

  --url <origin>       Pin a specific instance (otherwise auto-detected)
  --profile <name>     Use a specific browser profile, e.g. --profile "Profile 3"
  --paste              Skip the browser and paste a cURL/Cookie header instead
  --cookie <text>      Supply that paste non-interactively ($BLACKBOARD_COOKIE)
  --no-browser         Do not try to open a browser during the paste flow

HAR IMPORT
  --url <origin>       Override the auto-detected instance
  --no-session         Do not import cookies even if the HAR contains them
  --verbose            List every unmapped endpoint found

INSTALL
  blackboard-mcp install               Show snippets for every known client
  blackboard-mcp install cursor --write   Merge into Cursor's config
  --write              Actually edit the client's config file
  --local              Point at this checkout's dist/cli.js instead of npx
  --allow-writes       Include BLACKBOARD_MCP_ALLOW_WRITES=1 in the entry

  Clients: ${Object.keys(CLIENTS).join(', ')}

GLOBAL
  --log-level <level>  silent | error | warn | info | debug
  --version, --help

ENVIRONMENT
  BLACKBOARD_URL                    Instance origin (overrides stored config)
  BLACKBOARD_COOKIE                 Session cookie for non-interactive login
  BLACKBOARD_MCP_ALLOW_WRITES=1     Permit write operations (off by default)
  BLACKBOARD_MCP_DOWNLOAD_DIR       Where downloaded files go
  BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES Per-file download ceiling
  BLACKBOARD_MCP_LOG_LEVEL          Same as --log-level
  BLACKBOARD_MCP_HOME               State directory (default ~/.blackboard-mcp)
`;

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.logLevel && typeof flags.logLevel === 'string') {
    setLogLevel(flags.logLevel as LogLevel);
  }
  if (flags.version) {
    out(SERVER_VERSION);
    return 0;
  }
  if (flags.help) {
    out(HELP);
    return 0;
  }

  const [command, sub, ...rest] = flags._;

  switch (command) {
    case undefined:
    case 'serve':
      await startStdio();
      return -1; // Long-running; never resolves normally.

    case 'auth':
      return authCommand(sub, flags);

    case 'har':
      if (sub !== 'import') {
        out('Usage: blackboard-mcp har import <file.har>');
        return 2;
      }
      return harImportCommand(rest[0], flags);

    case 'doctor':
      return doctorCommand();

    case 'install':
      return installCommand(sub, flags);

    case 'courses':
      return coursesCommand();

    case 'endpoints':
      return endpointsCommand(sub);

    case 'help':
      out(HELP);
      return 0;

    default:
      out(`Unknown command "${command}".\n`);
      out(HELP);
      return 2;
  }
}

async function authCommand(sub: string | undefined, flags: Flags): Promise<number> {
  switch (sub) {
    case 'login': {
      const result = await login({
        url: typeof flags.url === 'string' ? flags.url : undefined,
        cookie: typeof flags.cookie === 'string' ? flags.cookie : undefined,
        noBrowser: flags.noBrowser === true,
        paste: flags.paste === true,
        profile: typeof flags.profile === 'string' ? flags.profile : undefined,
      });
      const { user, baseUrl } = result;
      out('');
      out(`Signed in as ${displayName(user)} (${user.userName ?? user.id})`);
      out(`Instance:    ${baseUrl}`);
      out(`Imported by: ${result.source === 'browser' ? 'browser (automatic)' : 'manual paste'}`);
      if (result.refreshed) {
        out('             (the browser session had expired and was renewed silently)');
      }
      out(`Session:     ${stateDir()}/session.enc (encrypted, mode 0600)`);
      out('');
      if (result.canAutoRefresh) {
        out('Auto-refresh: ENABLED. Identity-provider cookies were captured, so this');
        out('              session will renew itself without asking you again.');
      } else {
        out('Auto-refresh: unavailable. This session has no identity-provider cookies,');
        out('              so it will need a manual sign-in when it expires in a few');
        out('              hours. Run `blackboard-mcp auth login` without --paste to');
        out('              enable automatic renewal.');
      }
      out('');
      out('Next: `blackboard-mcp install` to register with your MCP client.');
      return 0;
    }

    case 'status': {
      const config = loadConfigOrNull();
      const session = await Session.tryLoad();
      if (!config || !session) {
        out('Not signed in. Run `blackboard-mcp auth login`.');
        return 1;
      }
      out(`Instance:  ${session.baseUrl}`);
      out(`User:      ${session.user?.displayName ?? '(unknown)'} ${session.user?.userName ? `(${session.user.userName})` : ''}`);
      out(`Captured:  ${session.capturedAt.toISOString()} (${session.ageHours.toFixed(1)}h ago)`);
      out(`Cookies:   ${(await session.cookieNames()).join(', ')}`);
      out(`XSRF:      ${session.xsrfToken ? 'present' : 'absent'}`);
      out(`Writes:    ${config.allowWrites ? 'ENABLED' : 'read-only'}`);
      out(`Downloads: ${config.downloadDir}`);
      out(
        `Auto-refresh: ${
          session.idpHosts.length > 0
            ? `enabled via ${session.idpHosts.join(', ')}`
            : 'unavailable (no identity-provider cookies)'
        }`,
      );

      try {
        const client = await BlackboardClient.create();
        const secs = await client.sessionSecondsRemaining();
        out(`Expires:   ${secs > 0 ? `in ${Math.round(secs / 60)} min` : 'EXPIRED'}`);
        const me = await client.whoami();
        out(`Live check: OK. ${displayName(me)}`);
        return secs > 0 ? 0 : 1;
      } catch (err) {
        out(`Live check: FAILED. ${toBlackboardError(err).describe()}`);
        return 1;
      }
    }

    case 'browsers': {
      const profiles = discoverProfiles();
      if (profiles.length === 0) {
        out('No browser profiles found.');
        return 1;
      }
      out('');
      out('Browser profiles on this machine:');
      for (const p of profiles) out(`  ${p.family.padEnd(9)} ${p.label}`);
      out('');
      out('Scanning for Blackboard sessions...');
      const found = await discoverInstances(profiles);
      if (found.length === 0) {
        out('  none. Sign in to Blackboard in your browser, then retry');
        return 1;
      }
      out('');
      for (const f of found) {
        out(`  ${f.hasBbRouter ? 'session ' : 'partial '} ${f.host.padEnd(30)} ${f.profile.label}`);
      }
      out('');
      out('Run `blackboard-mcp auth login` to import the best match automatically.');
      return 0;
    }

    case 'refresh': {
      const session = await Session.tryLoad();
      if (!session) {
        out('Not signed in. Run `blackboard-mcp auth login`.');
        return 1;
      }
      out(`Replaying the SSO chain for ${session.baseUrl}...`);
      const result = await refreshSession(session);
      out('');
      for (const hop of result.hops) out(`  ${hop}`);
      out('');
      if (result.ok) {
        out('Session renewed. No sign-in needed.');
        return 0;
      }
      out(`Renewal failed: ${result.reason ?? 'unknown'}`);
      if (result.needsInteractiveLogin) {
        out('');
        out('Your identity provider wants a real sign-in. Open Blackboard in your');
        out('browser, sign in, then run `blackboard-mcp auth login` again.');
      } else if (session.idpHosts.length === 0) {
        out('');
        out('This session has no identity-provider cookies, so it cannot be renewed');
        out('silently. Re-run `blackboard-mcp auth login` (without --paste) to import');
        out('them from your browser.');
      }
      return 1;
    }

    case 'logout': {
      await logout(flags.purge === true);
      out(flags.purge ? 'Session and encryption key removed.' : 'Session removed.');
      return 0;
    }

    default:
      out('Usage: blackboard-mcp auth <login|status|browsers|refresh|logout>');
      return 2;
  }
}

async function harImportCommand(file: string | undefined, flags: Flags): Promise<number> {
  if (!file) {
    out('Usage: blackboard-mcp har import <file.har> [--url <origin>] [--no-session]');
    return 2;
  }

  const result = await importHar(file, {
    url: typeof flags.url === 'string' ? flags.url : undefined,
    captureSession: flags.noSession !== true,
  });

  out('');
  out(`Instance detected:  ${result.baseUrl}`);
  out(`Entries scanned:    ${result.entries} (${result.apiEntries} Blackboard API calls)`);
  out(`Endpoints confirmed: ${result.confirmed.length}`);
  out(`Endpoints corrected: ${result.overrides.length}`);
  out(`Endpoints unseen:    ${result.unseen.length}`);
  out(`Unmapped API paths:  ${result.unmapped.length}`);
  out('');

  if (result.overrides.length > 0) {
    out('Corrections written to the endpoint profile:');
    for (const o of result.overrides) {
      out(`  ${o.operation}`);
      out(`    was: ${o.from}`);
      out(`    now: ${o.to}`);
    }
    out('');
  }

  if (result.unseen.length > 0) {
    out(`Not exercised by this recording (defaults kept): ${result.unseen.join(', ')}`);
    out('');
  }

  if (flags.verbose && result.unmapped.length > 0) {
    out('Endpoints present in the recording but not modelled by this package:');
    for (const u of result.unmapped) {
      out(`  ${String(u.count).padStart(4)}x  ${u.method.padEnd(6)} ${u.path}`);
    }
    out('');
    out('Reach any of these with the `bb_raw_request` tool.');
    out('');
  }

  out(
    result.sessionCaptured
      ? 'A session was recovered from the HAR. You are signed in.'
      : 'No usable cookies in the HAR (current Chrome strips them). Run `blackboard-mcp auth login` to sign in.',
  );
  return 0;
}

async function doctorCommand(): Promise<number> {
  let problems = 0;
  const ok = (label: string, detail = '') => out(`  OK    ${label}${detail ? `. ${detail}` : ''}`);
  const bad = (label: string, detail = '') => {
    problems += 1;
    out(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  };
  const warn = (label: string, detail = '') => out(`  WARN  ${label}${detail ? `. ${detail}` : ''}`);

  out('');
  out(`blackboard-mcp v${SERVER_VERSION} diagnostics`);
  out('');
  out('Environment');
  ok('node', process.version);
  ok('state dir', stateDir());
  ok('download dir', downloadDir());

  out('');
  out('Configuration');
  const config = loadConfigOrNull();
  if (!config) {
    bad('config', 'no instance configured. Run `blackboard-mcp auth login`');
  } else {
    ok('instance', config.baseUrl);
    ok('page size', String(config.pageSize));
    ok('max download', fmtBytes(config.maxDownloadBytes));
    if (config.allowWrites) warn('writes', 'ENABLED: tools may modify Blackboard state');
    else ok('writes', 'disabled (read-only)');
  }

  out('');
  out('Endpoints');
  const active = loadEndpoints();
  const overridden = Object.entries(active).filter(
    ([op, tmpl]) => tmpl !== DEFAULT_ENDPOINTS[op as keyof typeof DEFAULT_ENDPOINTS],
  );
  ok('operations', String(Object.keys(active).length));
  if (overridden.length > 0) {
    warn('overrides active', overridden.map(([op]) => op).join(', '));
  } else {
    ok('overrides', 'none (using built-in defaults)');
  }

  out('');
  out('Session');
  const session = await Session.tryLoad();
  if (!session) {
    bad('session', 'none stored. Run `blackboard-mcp auth login`');
  } else {
    ok('captured', `${session.capturedAt.toISOString()} (${session.ageHours.toFixed(1)}h ago)`);
    ok('cookies', (await session.cookieNames()).join(', '));
    if (!session.xsrfToken) warn('xsrf token', 'absent: write operations will likely fail');
    else ok('xsrf token', 'present');
    if (config && session.baseUrl !== config.baseUrl) {
      bad('instance match', `session is for ${session.baseUrl}, config says ${config.baseUrl}`);
    }
  }

  if (config && session) {
    out('');
    out('Connectivity');
    try {
      const http = new HttpClient(session, config);
      const started = Date.now();
      const me = await http.json<{ id: string; userName?: string }>({
        path: expand('self'),
        retries: 0,
      });
      ok('users/me', `${me.userName ?? me.id} (${Date.now() - started}ms)`);

      const client = new BlackboardClient(http, config);
      const secs = await client.sessionSecondsRemaining().catch(() => -1);
      if (secs > 0) ok('session ttl', `${Math.round(secs / 60)} min remaining`);
      else warn('session ttl', 'could not read');

      const courses = await client.listCourses({});
      ok('courses', `${courses.length} enrolled`);
    } catch (err) {
      bad('live request', toBlackboardError(err).describe());
    }
  }

  out('');
  out(problems === 0 ? 'No problems found.' : `${problems} problem(s) found.`);
  out('');
  return problems === 0 ? 0 : 1;
}

async function coursesCommand(): Promise<number> {
  const client = await BlackboardClient.create();
  const memberships = await client.listCourses({});
  out('');
  for (const m of memberships) {
    const id = (m.course?.id ?? m.courseId).padEnd(12);
    const term = m.course?.term?.name ? ` [${m.course.term.name}]` : '';
    out(`  ${id} ${courseLabel(m.course)}${term}`);
  }
  out('');
  out(`${memberships.length} course(s).`);
  return 0;
}

function endpointsCommand(filter: string | undefined): number {
  const active = loadEndpoints();
  const needle = filter?.toLowerCase();
  out('');
  let n = 0;
  for (const [op, tmpl] of Object.entries(active)) {
    if (needle && !`${op} ${tmpl}`.toLowerCase().includes(needle)) continue;
    const changed = tmpl !== DEFAULT_ENDPOINTS[op as keyof typeof DEFAULT_ENDPOINTS] ? ' *' : '';
    out(`  ${op.padEnd(26)} ${tmpl}${changed}`);
    n += 1;
  }
  out('');
  out(`${n} endpoint(s). Entries marked * are overridden by a local profile.`);
  return 0;
}

function installCommand(clientArg: string | undefined, flags: Flags): number {
  const opts = {
    write: flags.write === true,
    local: flags.local === true,
    allowWrites: flags.allowWrites === true,
  };

  const ids = clientArg ? [clientArg as ClientId] : (Object.keys(CLIENTS) as ClientId[]);

  for (const id of ids) {
    if (!CLIENTS[id]) {
      out(`Unknown client "${id}". Known: ${Object.keys(CLIENTS).join(', ')}`);
      return 2;
    }
    const result = install(id, opts);
    out('');
    out(`### ${result.client.label}${result.client.projectScoped ? ' (project-scoped)' : ''}`);
    if (result.path) out(`Config: ${result.path}`);
    out('');
    out(result.snippet);
    if (result.note) {
      out('');
      out(result.note);
    }
  }

  if (!clientArg) {
    out('');
    out('Pass a client name and --write to apply automatically, e.g.:');
    out('  blackboard-mcp install cursor --write');
  }
  out('');
  return 0;
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err) => {
    out('');
    out(toBlackboardError(err).describe());
    out('');
    process.exit(1);
  });
