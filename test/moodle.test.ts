import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ALLOWED_READ_FUNCTIONS,
  MoodleClient,
  MoodleError,
  createServer,
  parseMoodleDashboard,
  stripHtml,
  unixToIso,
} from '../vendor/moodle/src/index.js';
import { runtime as moodleRuntime } from '../src/platforms/moodle/runtime.js';
import { cookieHeader } from '../src/auth/cookies.js';
import { ProfileSchema } from '../src/config.js';
import { isAllowed, platformFor } from '../src/policy.js';
import { Vault } from '../src/vault.js';

const origin = 'https://moodle.school.example.edu';

test('Moodle client rejects insecure, subpath, or credential-bearing origins', () => {
  for (const bad of [
    'http://moodle.school.example.edu',
    'https://user:pass@moodle.school.example.edu',
    'https://moodle.school.example.edu/moodle',
    'https://moodle.school.example.edu?wstoken=abc',
  ]) {
    assert.throws(() => new MoodleClient({ baseUrl: bad, token: 'synthetic-token' }), (e: MoodleError) => e.code === 'BAD_INPUT');
  }
  assert.throws(() => new MoodleClient({ baseUrl: origin }), (e: MoodleError) => e.code === 'AUTH_REQUIRED');
});

test('Moodle token mode sends wstoken only in POST body, never in URL query strings', async () => {
  const seen: Array<{ url: URL; method: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    const params = new URLSearchParams(String(init?.body ?? ''));
    const fn = params.get('wsfunction');
    if (fn === 'core_webservice_get_site_info') {
      return Response.json({ userid: 77, username: 'student', fullname: 'Test Student', sitename: 'Example Moodle', release: '4.4' });
    }
    if (fn === 'core_enrol_get_users_courses') {
      return Response.json([{ id: 101, shortname: 'CS101', fullname: 'Intro CS', startdate: 1700000000, enddate: 0, visible: 1 }]);
    }
    if (fn === 'mod_assign_get_assignments') {
      return Response.json({
        courses: [{
          id: 101,
          fullname: 'Intro CS',
          assignments: [{ id: 55, cmid: 88, name: 'Lab 1', duedate: 1790000000, intro: '<p>Submit <b>PDF</b> &amp; code.</p>' }],
        }],
      });
    }
    if (fn === 'mod_forum_get_forums_by_courses') {
      return Response.json([{ id: 9, cmid: 19, course: 101, name: 'Announcements', type: 'news' }]);
    }
    if (fn === 'mod_forum_get_forum_discussions') {
      return Response.json({
        discussions: [{ id: 1, discussion: 301, subject: 'Midterm Room', userfullname: 'Prof A', created: 1789000000, timemodified: 1789000100, pinned: true, message: '<p>Room <b>B201</b></p>' }],
      });
    }
    if (fn === 'gradereport_user_get_grade_items') {
      return Response.json({
        usergrades: [{ courseid: 101, gradeitems: [{ id: 1, itemname: 'Lab 1', graderaw: 95, gradeformatted: '95.00', grademin: 0, grademax: 100, percentageformatted: '95%', feedback: '<p>Great work!</p>' }] }],
      });
    }
    if (fn === 'core_calendar_get_calendar_events') {
      return Response.json({
        events: [{ id: 501, name: 'Lab 1 Due', courseid: 101, eventtype: 'due', modulename: 'assign', timestart: 1790000000, timeduration: 3600 }],
      });
    }
    if (fn === 'core_course_get_contents') {
      return Response.json([{ id: 1, name: 'Week 1', summary: '<p>Welcome</p>', modules: [{ id: 11, name: 'Syllabus', modname: 'resource', url: `${origin}/mod/resource/view.php?id=11`, contents: [{ type: 'file', filename: 'syllabus.pdf', filesize: 1024, mimetype: 'application/pdf', timemodified: 1789000000 }] }] }]);
    }
    throw new Error(`Unexpected wsfunction: ${fn}`);
  };

  const client = new MoodleClient({ baseUrl: origin, token: 'synthetic-moodle-token', fetcher });
  const site = await client.getSiteInfo();
  assert.equal(site.userid, 77);
  assert.equal(site.auth_mode, 'token');

  const courses = await client.listCourses();
  assert.equal(courses.count, 1);
  assert.equal(courses.courses[0]?.shortname, 'CS101');

  const contents = await client.getCourseContents(101);
  assert.equal(contents.sections[0]?.modules[0]?.contents[0]?.filename, 'syllabus.pdf');

  const assignments = await client.listAssignments(101);
  assert.equal(assignments.assignments[0]?.due_at, unixToIso(1790000000));
  assert.equal(assignments.assignments[0]?.intro, 'Submit PDF & code.');

  const calendar = await client.listCalendarEvents({ daysAhead: 14 });
  assert.equal(calendar.events[0]?.starts_at, unixToIso(1790000000));
  assert.equal(calendar.events[0]?.ends_at, unixToIso(1790003600));

  const announcements = await client.listAnnouncements({ courseId: 101 });
  assert.equal(announcements.count, 1);
  assert.equal(announcements.announcements[0]?.subject, 'Midterm Room');
  assert.equal(announcements.announcements[0]?.message, 'Room B201');

  const grades = await client.getGrades(101);
  assert.equal(grades.items[0]?.grade_raw, 95);
  assert.equal(grades.items[0]?.feedback, 'Great work!');

  for (const req of seen) {
    assert.equal(req.url.hostname, 'moodle.school.example.edu');
    assert.equal(req.url.pathname, '/webservice/rest/server.php');
    assert.equal(req.url.search, '', 'wstoken must never appear in URL query strings');
    assert.equal(req.method, 'POST');
    assert.match(req.body, /wstoken=synthetic-moodle-token/);
  }
});

test('Moodle cookie mode resolves sesskey from /my/ and calls read-only AJAX endpoints', async () => {
  let dashboardHits = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'moodle.school.example.edu');
    assert.equal((init?.headers as Record<string, string>).Cookie, 'MoodleSession=synthetic-session');
    if (url.pathname === '/my/') {
      dashboardHits++;
      return new Response('<html><head><title>Dashboard | Uni Moodle</title></head><body data-userid="42"><script>M.cfg={"sesskey":"abc123XYZ","userId":42};</script></body></html>');
    }
    if (url.pathname === '/lib/ajax/service.php') {
      assert.equal(url.searchParams.get('sesskey'), 'abc123XYZ');
      const reqBody = JSON.parse(String(init?.body ?? '[]')) as Array<{ methodname: string }>;
      if (reqBody[0]?.methodname === 'core_course_get_enrolled_courses_by_timeline_classification') {
        return Response.json([{ error: false, data: { courses: [{ id: 202, fullname: 'Algorithms', shortname: 'ALG202' }] } }]);
      }
      if (reqBody[0]?.methodname === 'core_calendar_get_action_events_by_timesort') {
        return Response.json([{ error: false, data: { events: [{ id: 901, name: 'Quiz 1', timestart: 1790000000 }] } }]);
      }
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  const client = new MoodleClient({ baseUrl: origin, cookie: 'MoodleSession=synthetic-session', fetcher });
  const info = await client.getSiteInfo();
  assert.equal(info.userid, 42);
  assert.equal(info.auth_mode, 'cookie');
  const courses = await client.listCourses({ classification: 'inprogress' });
  assert.equal(courses.courses[0]?.id, 202);
  const events = await client.listCalendarEvents({ daysAhead: 7 });
  assert.equal(events.events[0]?.name, 'Quiz 1');
  assert.equal(dashboardHits, 1);
});

test('Moodle read-only allowlist rejects write/raw webservice functions before network access', async () => {
  let called = 0;
  const client = new MoodleClient({
    baseUrl: origin,
    token: 'synthetic-token',
    fetcher: async () => {
      called++;
      return Response.json({});
    },
  });
  for (const blocked of [
    'mod_assign_save_submission',
    'mod_quiz_start_attempt',
    'core_message_send_instant_messages',
    'core_message_mark_message_read',
    'mod_forum_add_discussion',
  ]) {
    assert.equal(ALLOWED_READ_FUNCTIONS.has(blocked), false);
    await assert.rejects(client.callFunction(blocked), (e: MoodleError) => e.code === 'TOOL_NOT_ALLOWED');
  }
  assert.equal(called, 0);
});

test('Moodle auth failures, redirects, guest sessions, and HTTP-200 error envelopes fail closed', async () => {
  assert.equal(parseMoodleDashboard('<html><form id="login"><input name="logintoken"></form></html>'), null);
  assert.equal(parseMoodleDashboard('<html><script>M.cfg={"sesskey":"abc123","userId":0};</script></html>'), null);

  for (const [response, expectedCode] of [
    [() => new Response(null, { status: 302, headers: { location: '/login/index.php' } }), 'AUTH_REQUIRED'],
    [() => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'AUTH_REQUIRED'],
    [() => Response.json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }), 'AUTH_REQUIRED'],
    [() => Response.json({ exception: 'required_capability_exception', errorcode: 'nopermissions', message: 'No permission' }), 'FORBIDDEN'],
    [() => Response.json({ exception: 'dml_missing_record_exception', errorcode: 'invalidcourseid', message: 'Missing course' }), 'NOT_FOUND'],
    [() => new Response('Forbidden', { status: 403 }), 'FORBIDDEN'],
    [() => new Response('Server error', { status: 500 }), 'UPSTREAM_FAILED'],
  ] as const) {
    const client = new MoodleClient({ baseUrl: origin, token: 'synthetic-token', fetcher: async () => response() });
    await assert.rejects(client.getSiteInfo(), (e: MoodleError) => e.code === expectedCode);
  }

  const ajaxExpired = new MoodleClient({
    baseUrl: origin,
    cookie: 'MoodleSession=expired',
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/my/') {
        return new Response('<html><body data-userid="12"><script>M.cfg={"sesskey":"sk1234","userId":12};</script></body></html>');
      }
      return Response.json([{ error: true, exception: { errorcode: 'servicerequireslogin', message: 'Session expired' } }]);
    },
  });
  await assert.rejects(ajaxExpired.listCourses(), (e: MoodleError) => e.code === 'AUTH_REQUIRED');
});

test('Moodle cookie scoping, vault isolation, policy ownership, and runtime validation work cleanly', async t => {
  const base = { name: 'MoodleSession', value: 'synthetic-sess', domain: 'moodle.school.example.edu', path: '/', secure: true };
  assert.equal(
    cookieHeader('moodle', origin, [
      base,
      { ...base, domain: 'login.microsoftonline.com', value: 'idp' },
      { ...base, name: 'tracking_id', value: 'skip' },
      { ...base, domain: 'evilmoodle.school.example.edu', value: 'sibling' },
    ]),
    'MoodleSession=synthetic-sess',
  );
  assert.equal(cookieHeader('moodle', origin, [{ ...base, secure: false }]), null);
  assert.equal(cookieHeader('moodle', origin, [{ ...base, expirationDate: 1 }]), null);
  assert.equal(cookieHeader('moodle', origin, [{ ...base, value: 'bad;evil=1' }]), null);

  assert.equal(platformFor('moodle_list_courses'), 'moodle');
  assert.equal(isAllowed('moodle_list_courses', 'moodle'), true);
  assert.equal(isAllowed('moodle_list_courses', 'canvas'), false);
  assert.equal(isAllowed('moodle_submit_assignment'), false);

  const prevHome = process.env.LMS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'lms-moodle-vault-'));
  process.env.LMS_HOME = home;
  t.after(async () => {
    if (prevHome === undefined) delete process.env.LMS_HOME;
    else process.env.LMS_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });
  const profile = ProfileSchema.parse({ id: 'uni-moodle', label: 'Uni Moodle', timezone: 'UTC', moodle: origin });
  const key = randomBytes(32);
  const vault = new Vault({ get: async () => key, set: async () => {} });
  await vault.write(profile, 'moodle', { kind: 'token', value: 'synthetic-token' });
  assert.equal((await vault.read<{ value: string }>(profile, 'moodle'))?.value.value, 'synthetic-token');
  assert.equal(await vault.read({ ...profile, moodle: 'https://other.moodle.example.edu' }, 'moodle'), null);

  t.mock.method(globalThis, 'fetch', async () => Response.json({ userid: 9, fullname: 'Alice' }));
  const validated = await moodleRuntime.validate({ profileId: profile.id, origin, stateHome: home }, { kind: 'token', value: 'synthetic-token' });
  assert.equal(validated.kind, 'token');
  assert.ok(validated.validatedAt);
});

test('Moodle MCP server lists all 9 read-only tools offline without network or credentials', async () => {
  const server = createServer(() => {
    throw new Error('Must not create client during tools/list');
  });
  const client = new Client({ name: 'moodle-mcp-test', version: '1' });
  const [a, z] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(z);
    await client.connect(a);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert(tools.every(tool => tool.annotations?.readOnlyHint === true));
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(stripHtml('<p>Hello &amp; <b>world</b></p>'), 'Hello & world');
});
