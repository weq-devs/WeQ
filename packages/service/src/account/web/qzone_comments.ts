/** Structured root-comment pages observed in the existing local QZone research. */
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { parseQzoneCallback } from './qzone';
import { webRequestText, WebRequestError } from './http';
import type { QzoneComment } from './qzone_interaction';

export interface QzoneCommentSnapshot {
  comments: QzoneComment[];
  reportedTotal: number | null;
  replyCounts: Record<string, number | null>;
  countMatched: boolean;
  requests: number;
}
export interface QzoneCommentReadOptions {
  signal?: AbortSignal;
  maxPages?: number;
  timeoutMs?: number;
  captureRaw?: (text: string) => Promise<void>;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function decimal(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function decodeError(): never {
  throw new WebRequestError('decode', '空间评论响应格式无效。');
}

export function parseQzoneCommentPage(
  value: unknown,
  owner: string,
  tid: string,
): {
  comments: QzoneComment[];
  reportedTotal: number | null;
  replyCounts: Record<string, number | null>;
} {
  const root = object(value);
  if (!root || typeof root.code !== 'number') return decodeError();
  if ([-3000, -4009, -10001, -10003].includes(root.code))
    throw new WebAuthError('空间评论票据已失效。', root.code);
  if (root.code !== 0)
    throw new WebRequestError(
      root.code === -10000 ? 'rate-limit' : 'http',
      `空间评论服务错误（${root.code}）。`,
    );
  const data = object(root.data);
  if (!data || decimal(data.hostUin) !== owner || data.tid !== tid || !Array.isArray(data.comments))
    return decodeError();
  const reportedTotal = count(data.total);
  if (data.total !== undefined && reportedTotal === null) return decodeError();
  const comments: QzoneComment[] = [];
  const replyCounts: Record<string, number | null> = Object.create(null);
  for (const raw of data.comments) {
    const row = object(raw),
      poster = object(row?.poster);
    const id = decimal(row?.id),
      uin = decimal(poster?.id);
    if (
      !row ||
      !poster ||
      id === null ||
      !uin ||
      uin === '0' ||
      typeof row.content !== 'string' ||
      typeof poster.name !== 'string'
    )
      return decodeError();
    const time = count(row.postTime);
    if (time === null || time > 100_000_000_000) return decodeError();
    if (Object.hasOwn(replyCounts, id)) return decodeError();
    replyCounts[id] = count(object(row.extendData)?.replyNum);
    comments.push({
      id,
      uin,
      nickname: poster.name,
      content: row.content,
      time,
      isReply: false,
      images: [],
    });
  }
  return { comments, reportedTotal, replyCounts };
}

async function pace(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, 300);
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** At most maxPages reads, never guesses a reply endpoint or equates missing data with zero. */
export async function readQzoneComments(
  cred: WebCredential,
  owner: string,
  tid: string,
  options: QzoneCommentReadOptions = {},
): Promise<QzoneCommentSnapshot> {
  if (!/^[1-9]\d*$/.test(owner) || !/^[a-zA-Z0-9_-]{1,128}$/.test(tid))
    throw new Error('空间评论目标无效。');
  const maxPages = options.maxPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20)
    throw new Error('空间评论分页预算无效。');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('空间评论时限无效。');
  const deadline = Date.now() + 45_000;
  const comments: QzoneComment[] = [],
    seen = new Set<string>();
  const replyCounts: Record<string, number | null> = Object.create(null);
  let reportedTotal: number | null = null,
    stableTotal = true,
    requests = 0,
    start = 0;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await pace(options.signal);
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const params = new URLSearchParams({
      need_private_comment: '1',
      uin: cred.uin,
      hostUin: owner,
      start: String(start),
      num: '50',
      order: '0',
      topicId: `${owner}_${tid}`,
      format: 'jsonp',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      ref: 'qzone',
      g_tk: String(computeBkn(cred.pskey || cred.skey)),
    });
    requests++;
    const text = await webRequestText(
      'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getcmtreply_v6?' +
        params,
      {
        cookie: cookieHeader(cred),
        signal: options.signal,
        timeoutMs: Math.min(timeoutMs, remaining),
        maxResponseBytes: 4 * 1024 * 1024,
        headers: { Referer: 'https://user.qzone.qq.com/' },
      },
    );
    await options.captureRaw?.(text);
    options.signal?.throwIfAborted();
    const result = parseQzoneCommentPage(parseQzoneCallback(text), owner, tid);
    if (page === 0) reportedTotal = result.reportedTotal;
    else if (reportedTotal !== result.reportedTotal) stableTotal = false;
    let added = 0;
    for (const comment of result.comments) {
      if (seen.has(comment.id)) {
        stableTotal = false;
        continue;
      }
      seen.add(comment.id);
      added++;
      comments.push(comment);
      replyCounts[comment.id] = result.replyCounts[comment.id]!;
    }
    start += result.comments.length;
    if (!stableTotal)
      return { comments, reportedTotal, replyCounts, countMatched: false, requests };
    const countMatched = stableTotal && reportedTotal !== null && comments.length === reportedTotal;
    if (
      countMatched ||
      result.comments.length === 0 ||
      added === 0 ||
      (reportedTotal === null && result.comments.length < 50)
    )
      return { comments, reportedTotal, replyCounts, countMatched, requests };
  }
  return { comments, reportedTotal, replyCounts, countMatched: false, requests };
}

/** Keep HTML observations as fallback while preferring a matched structured root snapshot. */
export async function supplementQzoneComments(
  cred: WebCredential,
  owner: string,
  targets: { tid: string }[],
  results: Map<string, import('./qzone_interaction').QzoneInteraction>,
  captureRaw?: (text: string, kind?: 'feeds' | 'comments', tid?: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<Map<string, import('./qzone_interaction').QzoneInteraction>> {
  let failures = 0;
  for (const [index, target] of targets.entries()) {
    if (index > 0) await pace(signal);
    signal?.throwIfAborted();
    try {
      const snapshot = await readQzoneComments(cred, owner, target.tid, {
        signal,
        captureRaw: captureRaw ? (text) => captureRaw(text, 'comments', target.tid) : undefined,
      });
      failures = 0;
      const previous = results.get(target.tid);
      const oldComments = previous?.comments ?? [];
      const oldRoots = new Map(
        oldComments.filter((comment) => !comment.isReply).map((comment) => [comment.id, comment]),
      );
      for (const comment of snapshot.comments) {
        const observed = oldRoots.get(comment.id);
        if (observed?.uin === comment.uin && observed.content === comment.content)
          comment.images = [...observed.images];
      }
      const roots = new Map(snapshot.comments.map((comment) => [comment.id, comment]));
      const replies = oldComments.filter(
        (comment) =>
          comment.isReply &&
          comment.parentCommentId &&
          oldRoots.get(comment.parentCommentId)?.uin === roots.get(comment.parentCommentId)?.uin &&
          oldRoots.has(comment.parentCommentId) &&
          roots.has(comment.parentCommentId) &&
          snapshot.replyCounts[comment.parentCommentId] !== 0,
      );
      const zeroReplies =
        snapshot.countMatched &&
        snapshot.comments.every((comment) => snapshot.replyCounts[comment.id] === 0);
      // Never replace a larger observed set with an incomplete structured scan.
      const comments = snapshot.countMatched
        ? [...snapshot.comments, ...replies]
        : [...oldComments];
      if (!snapshot.countMatched) {
        const existing = new Set(
          comments.map((comment) => `${comment.isReply}:${comment.id}:${comment.uin}`),
        );
        for (const comment of snapshot.comments)
          if (!existing.has(`false:${comment.id}:${comment.uin}`)) comments.push(comment);
      }
      results.set(target.tid, {
        comments,
        likes: previous?.likes ?? [],
        coverage: 'observed',
        fieldCoverage: {
          comments: snapshot.countMatched ? 'complete' : 'observed',
          replies: zeroReplies
            ? 'complete'
            : comments.some((comment) => comment.isReply)
              ? 'observed'
              : previous?.fieldCoverage?.replies === 'failed'
                ? 'failed'
                : 'unobserved',
          likes: previous?.fieldCoverage?.likes ?? 'unobserved',
        },
      });
    } catch (error) {
      signal?.throwIfAborted();
      const kind = error as { kind?: string; name?: string };
      if (
        kind.kind === 'rate-limit' ||
        kind.kind === 'authentication' ||
        kind.name === 'WebAuthError'
      )
        break;
      failures++;
      const previous = results.get(target.tid);
      if (!previous)
        results.set(target.tid, {
          comments: [],
          likes: [],
          coverage: 'unobserved',
          fieldCoverage: { comments: 'failed', replies: 'unobserved', likes: 'unobserved' },
        });
      if (failures >= 3) break;
    }
  }
  return results;
}
