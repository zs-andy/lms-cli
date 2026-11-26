import type { PlatformDefinition } from '../types.js';

export const moodle = {
  id: 'moodle' as const,
  label: 'Moodle',
  environmentPrefixes: ['MOODLE_'],
  readTools: [
    'moodle_get_profile',
    'moodle_list_courses',
    'moodle_get_course_contents',
    'moodle_list_assignments',
    'moodle_list_calendar_events',
    'moodle_list_forums',
    'moodle_list_discussions',
    'moodle_get_grades',
    'moodle_list_announcements',
  ],
  aliases: {
    profile: 'moodle_get_profile',
    courses: 'moodle_list_courses',
    contents: 'moodle_get_course_contents',
    assignments: 'moodle_list_assignments',
    calendar: 'moodle_list_calendar_events',
    forums: 'moodle_list_forums',
    discussions: 'moodle_list_discussions',
    grades: 'moodle_get_grades',
    announcements: 'moodle_list_announcements',
  },
  courseArgument: { name: 'course_id', type: 'number' },
  login: {
    cookieNames: /^(MoodleSession[A-Za-z0-9_-]*)$/,
    sessionCookieNames: ['MoodleSession'],
    probePath: '/my/',
  },
  probes: { identity: { tool: 'moodle_get_profile' }, courses: { tool: 'moodle_list_courses' } },
  overview: ({ days }) => ({
    calls: [
      { tool: 'moodle_list_courses', args: { classification: 'inprogress', limit: 50 } },
      { tool: 'moodle_list_announcements', args: { limit: 10, max_courses: 10 } },
      { tool: 'moodle_list_assignments' },
      { tool: 'moodle_list_calendar_events', args: { days_ahead: days, days_back: 0, limit: 50 } },
    ],
    scope: { maxCourses: 10, announcementsPerCourse: 10, calendarLimit: 50, attachmentsRead: false },
  }),
  limitations: 'Moodle access depends on institution-enabled Web Service APIs (token mode) or authenticated Moodle AJAX services (cookie session mode). Subpath deployments, custom session cookie prefixes, and disabled webservice functions may require institution-specific verification.',
  loadRuntime: async () => (await import('./runtime.js')).runtime,
} satisfies PlatformDefinition;
