import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

interface StatsResponse {
  code?: number;
  message?: string;
  error?: { type?: number; msg?: string };
  data?: {
    module_16?: { code?: number; data?: { SS?: unknown; XC?: unknown } };
    modvisitcount?: Array<{ mod?: unknown; totalcount?: unknown; todaycount?: unknown }>;
  };
}

function accepted(text: string): StatsResponse {
  const response = parseQzoneCallback<StatsResponse>(text);
  const code = response.error?.type ?? response.code;
  if (code !== 0) {
    // The legacy visitor endpoint uses error.type=-3 for expired credentials.
    if (code === -3 || code === -3000 || code === -10000)
      throw new WebAuthError('空间统计登录态失效，请重新登录。', code);
    throw new Error('暂时无法读取空间统计，请稍后重试。');
  }
  return response;
}

function count(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export function parseQzoneContentCounts(text: string) {
  const module = accepted(text).data?.module_16;
  if (module?.code !== undefined && module.code !== 0)
    throw new Error('暂时无法读取空间内容统计，请稍后重试。');
  return { postCount: count(module?.data?.SS), photoCount: count(module?.data?.XC) };
}

export function parseQzoneVisitorCount(text: string): number | null {
  return parseQzoneVisitorStats(text).totalCount;
}

export function parseQzoneVisitorStats(text: string) {
  const rows = accepted(text).data?.modvisitcount;
  const matches = Array.isArray(rows) ? rows.filter((row) => row.mod === 0) : [];
  return {
    totalCount: matches.length === 1 ? count(matches[0]?.totalcount) : null,
    todayCount: matches.length === 1 ? count(matches[0]?.todaycount) : null,
  };
}

async function readStats(
  cred: WebCredential,
  hostUin: string,
  endpoint: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    uin: hostUin,
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
    ...query,
  });
  return webRequestText(`https://user.qzone.qq.com/proxy/domain/${endpoint}?${params}`, {
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
    signal,
    retry: WEB_READ_RETRY,
  });
}

export async function fetchQzoneContentCounts(
  cred: WebCredential,
  hostUin: string,
  signal?: AbortSignal,
) {
  return parseQzoneContentCounts(
    await readStats(cred, hostUin, 'r.qzone.qq.com/cgi-bin/main_page_cgi', { param: '16' }, signal),
  );
}

export async function fetchQzoneVisitorCount(
  cred: WebCredential,
  hostUin: string,
  signal?: AbortSignal,
) {
  return parseQzoneVisitorCount(
    await readStats(
      cred,
      hostUin,
      'g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_simple',
      { mask: '1' },
      signal,
    ),
  );
}

export async function fetchQzoneVisitorStats(cred: WebCredential, signal?: AbortSignal) {
  return parseQzoneVisitorStats(
    await readStats(
      cred,
      cred.uin,
      'g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_simple',
      { mask: '1' },
      signal,
    ),
  );
}
