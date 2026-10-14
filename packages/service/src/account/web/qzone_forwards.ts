/** Read-only retweet pages from Qzone's official RetweetListViewModel. */
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { parseQzoneCallback } from './qzone';
import { webRequestText, WebRequestError } from './http';

export interface QzoneForward {
  tid: string;
  uin: string;
  nickname: string;
  content: string;
  time: number | null;
}
export interface QzoneForwardPage {
  forwards: QzoneForward[];
  reportedTotal: number | null;
  visibleTotal: number | null;
  nextOffset: number | null;
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

/** The official list uses post[].owner, not rtlist (which describes a retweet chain). */
export function parseQzoneForwardPage(
  value: unknown,
  offset: number,
  pageSize: number,
): QzoneForwardPage {
  const root = object(value);
  const code = root?.code ?? object(root?.result)?.code;
  if (typeof code !== 'number') return invalid();
  if ([-3000, -4009, -10001, -10003].includes(code))
    throw new WebAuthError('转发名单票据已失效。', code);
  if (code !== 0)
    throw new WebRequestError(
      code === -10000 ? 'rate-limit' : 'http',
      `转发名单服务错误（${code}）。`,
    );
  const reportedTotal = count(root!.total);
  const visibleTotal = count(root!.total4show);
  if (
    (root!.total !== undefined && reportedTotal === null) ||
    (root!.total4show !== undefined && visibleTotal === null)
  )
    return invalid();
  const rows =
    (root!.post === undefined || root!.post === null) &&
    reportedTotal === 0 &&
    (visibleTotal === null || visibleTotal === 0)
      ? []
      : root!.post;
  // A missing list is not proof that no one forwarded the post.
  if (!Array.isArray(rows)) return invalid();
  const forwards: QzoneForward[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = object(raw),
      owner = object(row?.owner);
    const uin = String(owner?.uin ?? '');
    const tid = String(row?.t2_tid ?? '');
    if (
      !row ||
      !owner ||
      !/^[1-9]\d{4,19}$/.test(uin) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(tid) ||
      typeof row.content !== 'string'
    )
      return invalid();
    const key = `${uin}:${tid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    forwards.push({
      tid,
      uin,
      nickname: typeof owner.name === 'string' ? owner.name : '',
      content: row.content,
      time: count(row.createTime),
    });
  }
  const total = visibleTotal ?? reportedTotal;
  const next = offset + rows.length;
  return {
    forwards,
    reportedTotal,
    visibleTotal,
    nextOffset: rows.length === pageSize && (total === null || next < total) ? next : null,
  };
}

export async function fetchQzoneForwardPage(
  cred: WebCredential,
  owner: string,
  tid: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<QzoneForwardPage> {
  if (
    !/^[1-9]\d{4,19}$/.test(owner) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(tid) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  )
    throw new Error('转发名单目标无效。');
  const pageSize = 20;
  // Official read parameters: qzs.qq.com/qzone/app/controls/retweetList/
  // retweetListViewModel/retweetListViewModel_3.0.js; request wrapper in moodRequest_3.0.js.
  const params = new URLSearchParams({
    t1_source: '1',
    uin: owner,
    tid,
    pos: String(offset),
    count: String(pageSize),
    show: '1',
    code_version: '1',
    format: 'jsonp',
    out_charset: 'UTF-8',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const text = await webRequestText(
    'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_get_fullrelay_v6?' +
      params,
    {
      cookie: cookieHeader(cred),
      signal,
      timeoutMs: 10_000,
      maxResponseBytes: 2 * 1024 * 1024,
      headers: { Referer: `https://user.qzone.qq.com/${owner}` },
    },
  );
  signal?.throwIfAborted();
  return parseQzoneForwardPage(parseQzoneCallback(text), offset, pageSize);
}
