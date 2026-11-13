import { createHash } from 'node:crypto';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { parseQzoneJson } from './qzone';
import { webRequestText, WebRequestError } from './http';

export interface QzoneForward {
  key: string;
  uin: string;
  nickname: string;
  content: string;
  isFriend: boolean;
}
export interface QzoneForwardCursor {
  attachInfo: string;
  previousPageKey: string;
}
export interface QzoneForwardPage {
  forwards: QzoneForward[];
  reportedTotal: number | null;
  rawCount: number;
  hasMore: boolean;
  nextCursor: QzoneForwardCursor | null;
  stopReason: 'complete' | 'repeated-page' | 'repeated-cursor' | null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function count(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function invalid(): never {
  throw new WebRequestError('decode', '转发名单响应格式无效。');
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  const record = object(value);
  return record
    ? Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, ordered(record[key])]),
      )
    : value;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 对比完整原始页，保留行顺序；游标变化不代表服务端确实返回了新页。 */
export function parseQzoneForwardPage(
  value: unknown,
  cursor: QzoneForwardCursor | null = null,
): QzoneForwardPage {
  const root = object(value);
  const code = root?.ret;
  if (typeof code !== 'number') return invalid();
  if ([-3000, -4009, -10001, -10003].includes(code))
    throw new WebAuthError('转发名单票据已失效。', code);
  if (code !== 0)
    throw new WebRequestError(
      code === -10000 ? 'rate-limit' : 'http',
      `转发名单服务错误（${code}）。`,
    );
  const data = object(root?.data);
  const rows = data?.list;
  const friendNum = count(data?.friend_num);
  const reportedTotal = count(data?.total_num);
  if (
    !data ||
    !Array.isArray(rows) ||
    friendNum === null ||
    friendNum > rows.length ||
    (data.total_num !== undefined && reportedTotal === null) ||
    ![0, 1, false, true].includes(data.hasmore as number | boolean)
  )
    return invalid();
  const hasMore = data.hasmore === 1 || data.hasmore === true;
  const pageKey = hash(JSON.stringify(ordered(rows)));
  const forwards: QzoneForward[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rows.entries()) {
    const row = object(raw),
      user = object(row?.user);
    const uin = String(user?.uin ?? '');
    if (!row || !user || !/^[1-9]\d{4,19}$/.test(uin) || typeof row.forward_text !== 'string')
      return invalid();
    // 此接口没有转发帖 ID；保留同一用户不同转发语。
    const key = hash(JSON.stringify([uin, row.forward_text]));
    if (seen.has(key)) continue;
    seen.add(key);
    forwards.push({
      key,
      uin,
      nickname: typeof user.nickname === 'string' ? user.nickname : '',
      content: row.forward_text,
      isFriend: index < friendNum,
    });
  }
  const repeated = rows.length > 0 && cursor?.previousPageKey === pageKey;
  const repeatedCursor =
    hasMore && typeof data.attach_info === 'string' && data.attach_info === cursor?.attachInfo;
  const stopReason = !hasMore
    ? 'complete'
    : repeated
      ? 'repeated-page'
      : repeatedCursor
        ? 'repeated-cursor'
        : null;
  if (
    !stopReason &&
    (typeof data.attach_info !== 'string' ||
      !data.attach_info ||
      data.attach_info.length > 8192 ||
      rows.length === 0)
  )
    return invalid();
  return {
    forwards: repeated ? [] : forwards,
    reportedTotal,
    rawCount: rows.length,
    hasMore,
    nextCursor: stopReason
      ? null
      : { attachInfo: data.attach_info as string, previousPageKey: pageKey },
    stopReason,
  };
}

/** Android 普通说说名单使用 URL 业务键；请求 uin 是登录者，不是原帖作者。 */
export async function fetchQzoneForwardPage(
  cred: WebCredential,
  owner: string,
  tid: string,
  cursor: QzoneForwardCursor | null = null,
  signal?: AbortSignal,
): Promise<QzoneForwardPage> {
  signal?.throwIfAborted();
  if (
    !/^[1-9]\d{4,19}$/.test(owner) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(tid) ||
    (cursor &&
      (!cursor.attachInfo ||
        cursor.attachInfo.length > 8192 ||
        !/^[a-f0-9]{64}$/.test(cursor.previousPageKey)))
  )
    throw new Error('转发名单目标无效。');
  const params = new URLSearchParams({
    uin: cred.uin,
    unikey: `http://user.qzone.qq.com/${owner}/mood/${tid}_forward`,
    attach_info: cursor?.attachInfo ?? '',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const text = await webRequestText(
    `https://h5.qzone.qq.com/webapp/json/mobile_extra_protocol/getForwardList?${params}`,
    {
      cookie: cookieHeader(cred),
      signal,
      timeoutMs: 10_000,
      maxResponseBytes: 2 * 1024 * 1024,
      headers: { Referer: 'https://h5.qzone.qq.com/' },
    },
  );
  signal?.throwIfAborted();
  return parseQzoneForwardPage(parseQzoneJson(text), cursor);
}
