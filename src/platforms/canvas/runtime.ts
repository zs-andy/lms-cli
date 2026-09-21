import type { PlatformRuntime } from '../types.js';

export const runtime: PlatformRuntime = {
  configure({ origin }) {
    process.env.CANVAS_BASE_URL = origin;
    process.env.CANVAS_NO_KEYCHAIN = '1';
  },
  async validate(context, candidate) {
    await runtime.install(context, { ...candidate, validatedAt: '' }, async () => {});
    // Every validation uses a fresh worker, so upstream credential caches cannot be stale.
    const { canvasGet } = await import('../../../vendor/canvas/src/canvas.js');
    const me = await canvasGet('/users/self/profile');
    if (!me?.id) throw new Error('Identity probe failed');
    return { ...candidate, validatedAt: new Date().toISOString() };
  },
  async install(_context, credential) {
    if (credential?.kind === 'token') process.env.CANVAS_API_TOKEN = credential.value;
    else if (credential?.kind === 'cookie') process.env.CANVAS_COOKIE = credential.value;
    else if (credential) throw new Error('Unsupported Canvas credential');
    if (credential?.userAgent) process.env.CANVAS_USER_AGENT = credential.userAgent;
  },
  async serve() { await import('../../../vendor/canvas/src/index.js'); },
};
