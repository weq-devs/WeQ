/**
 * NapCat 外部 rkey 服务器客户端。
 *
 * 调用方式（NapCat HTTP 服务器）：
 *
 *   GET <base>/get_rkey_server?access_token=<token>
 *
 * 返回 `data.private_rkey` / `data.group_rkey`（均自带 `&rkey=` 前缀）与
 * `data.expired_time`（unix 秒）。地址结尾如果带了 `/get_rkey_server`，
 * {@link normalizeNapcatBaseUrl} 会把它剥掉，两种填法都能用。
 */

import { getLogger, logErrorContext } from '../common/logger';

/** NapCat 接口路径。 */
const ENDPOINT = 'get_rkey_server';

/** 拉取超时（毫秒）。本地服务器一般毫秒级返回，8s 足够且不会卡住下载。 */
const FETCH_TIMEOUT_MS = 8000;

export interface NapcatRkeyServerResult {
  /** 服务器自报的名字（NapCat 控制台里的实例名，如 "NapCat 4"）。 */
  name: string;
  /** 私聊图片 rkey，自带 `&rkey=` 前缀。 */
  privateRkey: string;
  /** 群聊图片 rkey，自带 `&rkey=` 前缀。 */
  groupRkey: string;
  /** rkey 过期时间（unix 秒）。 */
  expiredTime: number;
}

const logger = getLogger().child({ scope: 'rkey-server' });

/**
 * 规范化 NapCat HTTP 地址：
 *   - 去首尾空白；
 *   - 结尾带 `/get_rkey_server` 或 `get_rkey_server` 时剥掉；
 *   - 没写协议时补 `http://`；
 *   - 去掉结尾多余的 `/`。
 */
export function normalizeNapcatBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  const lower = url.toLowerCase();
  if (lower.endsWith(`/${ENDPOINT}`)) {
    url = url.slice(0, url.length - ENDPOINT.length - 1);
  } else if (lower.endsWith(ENDPOINT)) {
    url = url.slice(0, url.length - ENDPOINT.length);
  }
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** 向 NapCat 服务器拉取最新 rkey。失败抛 Error（带人类可读原因）。 */
export async function fetchNapcatRkeys(
  baseUrl: string,
  accessToken: string,
): Promise<NapcatRkeyServerResult> {
  const normalized = normalizeNapcatBaseUrl(baseUrl);
  if (!normalized) throw new Error('服务器地址为空');
  if (!accessToken.trim()) throw new Error('access_token 为空');
  const url = `${normalized}/${ENDPOINT}?access_token=${encodeURIComponent(accessToken.trim())}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    logger.warn('external rkey server unreachable', {
      event: 'rkey-server-unreachable',
      url: normalized,
      ...logErrorContext(e),
    });
    throw new Error('无法连接服务器，请检查地址与网络');
  }
  if (!res.ok) {
    const detail = res.status === 403 ? '（token 校验失败）' : '';
    throw new Error(`服务器返回 HTTP ${res.status} ${detail}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('服务器返回了无法解析的响应');
  }
  return parseNapcatPayload(json);
}

function parseNapcatPayload(json: unknown): NapcatRkeyServerResult {
  if (!json || typeof json !== 'object') {
    throw new Error('服务器返回了无法解析的响应');
  }
  const root = json as Record<string, unknown>;
  if (root.status !== 'ok' && root.retcode !== 0) {
    const message =
      typeof root.message === 'string' && root.message.trim() ? root.message : '服务器拒绝了请求';
    throw new Error(message);
  }
  const data = root.data;
  if (!data || typeof data !== 'object') throw new Error('服务器响应缺少 data 字段');
  const d = data as Record<string, unknown>;
  const privateRkey = typeof d.private_rkey === 'string' ? d.private_rkey : '';
  const groupRkey = typeof d.group_rkey === 'string' ? d.group_rkey : '';
  const expiredTime = typeof d.expired_time === 'number' ? d.expired_time : 0;
  if (!privateRkey && !groupRkey) throw new Error('服务器返回的 rkey 为空');
  return {
    name: typeof d.name === 'string' ? d.name : '',
    privateRkey,
    groupRkey,
    expiredTime,
  };
}
