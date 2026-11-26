import type { PlatformRuntime } from '../types.js';

export const runtime: PlatformRuntime = {
  configure({ origin }) {
    process.env.MOODLE_BASE_URL = origin;
  },
  async validate(context, candidate) {
    if (candidate.kind !== 'token' && candidate.kind !== 'cookie') {
      throw new Error('Unsupported Moodle credential kind');
    }
    const { MoodleClient } = await import('../../../vendor/moodle/src/client.js');
    const client = new MoodleClient({
      baseUrl: context.origin,
      token: candidate.kind === 'token' ? candidate.value : undefined,
      cookie: candidate.kind === 'cookie' ? candidate.value : undefined,
      userAgent: candidate.userAgent,
    });
    const info = await client.getSiteInfo();
    if (!info?.userid) throw new Error('Identity probe failed');
    return { ...candidate, validatedAt: new Date().toISOString() };
  },
  async install(_context, credential) {
    delete process.env.MOODLE_API_TOKEN;
    delete process.env.MOODLE_COOKIE;
    delete process.env.MOODLE_USER_AGENT;
    if (credential?.kind === 'token') process.env.MOODLE_API_TOKEN = credential.value;
    else if (credential?.kind === 'cookie') process.env.MOODLE_COOKIE = credential.value;
    else if (credential) throw new Error('Unsupported Moodle credential');
    if (credential?.userAgent) process.env.MOODLE_USER_AGENT = credential.userAgent;
  },
  async serve() {
    const { startStdio } = await import('../../../vendor/moodle/src/index.js');
    await startStdio();
  },
};
