import type { PlatformDefinition } from '../types.js';

/** Copy this directory and replace every example value. Never register the template itself. */
export const example = {
  id: 'example' as const,
  label: 'Example LMS',
  environmentPrefixes: ['EXAMPLE_'],
  // Audit the implementation of each tool, including indirect side effects.
  readTools: ['example_profile', 'example_courses'],
  aliases: { profile: 'example_profile', courses: 'example_courses' },
  courseArgument: { name: 'course_id', type: 'string' },
  login: {
    cookieNames: /^(example_session)$/,
    sessionCookieNames: ['example_session'],
    probePath: '/api/me',
  },
  probes: { identity: { tool: 'example_profile' }, courses: { tool: 'example_courses' } },
  // Optional overview({ days, now }): { calls, scope }. Only add genuinely supported reads.
  // Omission is reported as an explicit coverage gap, never an empty successful timetable.
  limitations: 'Template only. No upstream connector, login or school compatibility is implemented.',
  loadRuntime: async () => (await import('./runtime.js')).runtime,
} satisfies PlatformDefinition;
