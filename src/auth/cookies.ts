import type { Platform } from '../config.js';
export interface LoginCookie { name: string; value: string; domain?: string; path?: string; secure?: boolean; expirationDate?: number; }
const names: Record<Platform, RegExp> = {
  canvas: /^(canvas_session|_csrf_token|_normandy_session|log_session_id)$/,
  blackboard: /^(BbRouter|JSESSIONID|xsrf|AWSELB[A-Za-z0-9_-]*|BbAuth[A-Za-z0-9_-]*|s_session_id|session_id)$/,
};
/** Only explicitly reviewed LMS cookies, valid for the exact configured host/API path. Never persist IdP cookies. */
export function cookieHeader(platform: Platform, origin: string, cookies: LoginCookie[]): string | null {
  const host = new URL(origin).hostname;
  const api = platform === 'canvas' ? '/api/v1/users/self/profile' : '/learn/api/v1/users/me';
  const selected = cookies.filter(c => {
    const domain = (c.domain ?? '').replace(/^\./, '');
    const match = host === domain || (c.domain?.startsWith('.') && host.endsWith(`.${domain}`));
    const path = c.path || '/';
    return match && names[platform].test(c.name) && c.secure && (api === path || api.startsWith(path.endsWith('/') ? path : `${path}/`)) &&
      (!c.expirationDate || c.expirationDate > Date.now() / 1000) && !/[;\r\n]/.test(c.value);
  }).sort((a, b) => (b.path ?? '/').length - (a.path ?? '/').length);
  const unique = selected.filter((c, i) => selected.findIndex(x => x.name === c.name) === i);
  const valid = unique.some(c => platform === 'canvas' ? c.name === 'canvas_session' : ['BbRouter', 'JSESSIONID'].includes(c.name));
  return valid ? unique.map(c => `${c.name}=${c.value}`).join('; ') : null;
}
export function allowedNavigation(url: string) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
