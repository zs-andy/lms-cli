import { VERSION } from './version.js';

export const RELEASES_URL = 'https://github.com/zs-andy/lms-cli/releases';
export const RELEASE_API = 'https://api.github.com/repos/zs-andy/lms-cli/releases/latest';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(input: string) {
  const match = input.length <= 100 ? VERSION_RE.exec(input.replace(/^v/, '')) : null;
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p.startsWith('0') || !Number.isSafeInteger(Number(p))))) return null;
  return { core, pre };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! > right.core[i]! ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function portableAsset(version: string, platform = process.platform, arch = process.arch) {
  if (!parseVersion(version) || !['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) return null;
  return `lms-cli-${version.replace(/^v/, '')}-${platform}-${arch}.tar.gz`;
}

export type UpdateInfo = {
  status: 'available' | 'current' | 'ahead' | 'unavailable' | 'no-release' | 'disabled';
  current: string;
  latest?: string;
  checkedAt: string;
  releaseUrl: string;
  asset?: { name: string; url: string };
  checksumUrl?: string;
  message: string;
};

/** Fixed public endpoint only: no school origins, identifiers, credentials or user-supplied URLs. */
export async function fetchRelease(fetcher: typeof fetch = fetch) {
  const response = await fetcher(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'lms-cli-update-check' },
    signal: AbortSignal.timeout(3500), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error('Release check unavailable');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('Release response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function inspectRelease(data: unknown, current = VERSION, platform = process.platform, arch = process.arch): UpdateInfo {
  const base = { current, checkedAt: new Date().toISOString(), releaseUrl: RELEASES_URL };
  if (data === null) return { ...base, status: 'no-release', message: '尚无可用的稳定版 Release；不会安装预览版或同名 npm 包。' };
  const release = data as Record<string, unknown>;
  const tag = release?.tag_name;
  if (typeof tag !== 'string' || !/^v\d/.test(tag) || !parseVersion(tag) || release.draft !== false || release.prerelease !== false || parseVersion(tag)!.pre.length || !Array.isArray(release.assets)) throw new Error('Invalid release metadata');
  const latest = tag.slice(1), releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
  const assetName = portableAsset(latest, platform, arch);
  const assets = release.assets;
  const find = (name: string) => assets.find((a: any) => a?.name === name && a?.state === 'uploaded' && a?.browser_download_url === `${RELEASES_URL}/download/${tag}/${name}`) as { name: string; browser_download_url: string } | undefined;
  const asset = assetName ? find(assetName) : undefined, checksum = find('SHA256SUMS.txt');
  const comparison = compareVersions(latest, current);
  const status = comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current';
  return {
    ...base, latest, releaseUrl, status,
    ...(asset && checksum ? { asset: { name: asset.name, url: asset.browser_download_url }, checksumUrl: checksum.browser_download_url } : {}),
    message: status === 'available' ? `发现新版本 ${latest}。运行 lms update 查看并确认升级；账号配置和凭据会保留。${asset && checksum ? '' : ' 当前系统的自包含安装包或校验和尚未发布，请查看 Release。'}`
      : status === 'ahead' ? '当前版本比已发布稳定版更新，不会自动降级。' : '当前已是最新稳定版。',
  };
}

export async function checkForUpdates(options: { automatic?: boolean; fetcher?: typeof fetch; current?: string } = {}): Promise<UpdateInfo> {
  const current = options.current ?? VERSION;
  const base = { current, checkedAt: new Date().toISOString(), releaseUrl: RELEASES_URL };
  if (options.automatic && process.env.LMS_UPDATE_CHECK === '0') return { ...base, status: 'disabled', message: '已通过 LMS_UPDATE_CHECK=0 关闭自动更新检查。' };
  try { return inspectRelease(await fetchRelease(options.fetcher), current); }
  catch { return { ...base, status: 'unavailable', message: '暂时无法检查更新（网络、限流或发布信息不可用）。现有查询不受影响；可稍后运行 lms update --check 重试。' }; }
}

/** One request per MCP session, deferred until the first user call; never on the stdio protocol channel. */
let sessionCheck: Promise<UpdateInfo> | undefined;
export function sessionUpdate() { return sessionCheck ??= checkForUpdates({ automatic: true }); }
