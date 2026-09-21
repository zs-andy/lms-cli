import { isIP } from 'node:net';
import { presets, type Platform } from './config.js';
import { LmsError } from './errors.js';

export const CANVAS_DIRECTORY = 'https://canvas.instructure.com/api/v1/accounts/search';
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const MAX_BYTES = 256 * 1024;
export type SchoolMatch = {
  id: string; name: string; source: 'preset' | 'canvas-directory';
  platforms: Partial<Record<Platform, string>>; timezone?: string;
};
export type SchoolSearchOptions = { platform?: Platform; offline?: boolean };
export type SchoolSearchResult = {
  ok: true; query: string; matches: SchoolMatch[]; partial: boolean;
  sources: Array<{ source: string; status: 'ok' | 'offline' | 'unavailable' | 'unsupported'; message: string }>;
  note: string;
};

/** Directory results are untrusted suggestions, never requests or login instructions. */
export function directoryOrigin(domain: unknown): string | undefined {
  if (typeof domain !== 'string' || !domain || domain.length > 253 || unsafeText.test(domain) || /[\s\\/@?#:]/u.test(domain)) return;
  try {
    const url = new URL(`https://${domain}`);
    const host = url.hostname;
    if (isIP(host) || !host.includes('.') || /\.(localhost|local|internal|invalid|test)$/.test(host)) return;
    if (host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63)) return;
    return url.origin;
  } catch { return; }
}

function queryText(input: string): string {
  if (typeof input !== 'string' || unsafeText.test(input)) throw new LmsError('BAD_INPUT', '请输入学校名称或域名，不含控制字符。');
  const query = input.normalize('NFKC').trim();
  if (query.length < 2 || query.length > 120 || /[\/@?#:]/.test(query)) throw new LmsError('BAD_INPUT', '搜索词需为 2–120 个字符的学校名称或域名；平台网址请通过手动配置输入。');
  return query;
}

async function readDirectory(response: Response): Promise<unknown> {
  if (!response.ok || !/^application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('Directory unavailable');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new Error('Directory response too large'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Directory response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function searchSchools(input: string, options: SchoolSearchOptions = {}, fetcher: typeof fetch = fetch): Promise<SchoolSearchResult> {
  const query = queryText(input);
  if (options.platform && !['canvas', 'blackboard'].includes(options.platform)) throw new LmsError('BAD_INPUT', '学校搜索支持 canvas 或 blackboard。');
  const needle = query.toLocaleLowerCase();
  const matches: SchoolMatch[] = [];
  for (const preset of presets) {
    const aliases = preset.name === 'polyu' ? ['香港理工大学', '香港理工大學', '理大'] : [];
    const { label, timezone } = preset.profile;
    const origins = Object.fromEntries(Object.entries(preset.profile).filter(([key]) => ['canvas', 'blackboard'].includes(key) && (!options.platform || key === options.platform))) as SchoolMatch['platforms'];
    if (Object.keys(origins).length && [preset.name, label, ...aliases, ...Object.values(origins)].some(value => value.toLocaleLowerCase().includes(needle))) {
      matches.push({ id: `preset:${preset.name}`, name: label, source: 'preset', platforms: origins, timezone });
    }
  }
  const sources: SchoolSearchResult['sources'] = [{ source: 'preset', status: 'ok', message: '随 CLI 分发的学校配置。' }];
  if (!options.platform || options.platform === 'blackboard') sources.push({ source: 'blackboard-directory', status: 'unsupported', message: 'Blackboard 目前提供本地预设搜索和手动网址接入；未接入公开在线目录。' });
  if (!options.platform || options.platform === 'canvas') {
    if (options.offline) sources.push({ source: 'canvas-directory', status: 'offline', message: '已关闭联网搜索，仅显示本地预设。' });
    else {
      try {
        const url = new URL(CANVAS_DIRECTORY);
        url.searchParams.set(directoryOrigin(query) ? 'domain' : 'name', query);
        // Never attach saved school credentials, follow redirects, or probe returned domains.
        const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'User-Agent': 'lms-cli-school-search' } });
        const data = await readDirectory(response);
        if (!Array.isArray(data)) throw new Error('Invalid directory response');
        const seen = new Set<string>();
        for (const row of data.slice(0, 100)) {
          if (!row || typeof row !== 'object' || typeof row.name !== 'string' || unsafeText.test(row.name)) continue;
          const name = row.name.trim(); const origin = directoryOrigin(row.domain);
          if (!name || name.length > 100 || !origin || seen.has(origin)) continue;
          seen.add(origin);
          // A domain can have several SSO providers; the school login page selects the provider.
          matches.push({ id: `canvas:${new URL(origin).hostname}`, name, source: 'canvas-directory', platforms: { canvas: origin } });
          if (seen.size >= 20) break;
        }
        sources.push({ source: 'canvas-directory', status: 'ok', message: 'Canvas 官方学校目录；结果数量由目录限制，可缩小关键词或改用域名搜索。' });
      } catch {
        sources.push({ source: 'canvas-directory', status: 'unavailable', message: 'Canvas 在线目录暂时不可用；可重试、选择本地预设或手动输入学校网址。' });
      }
    }
  }
  return { ok: true, query, matches, sources, partial: sources.some(s => s.status !== 'ok'), note: '搜索结果用于发现学校网址，不代表兼容性验证。保存前请核对学校和域名；授权后运行连接检查。同一站点的登录方式由学校页面选择。' };
}
