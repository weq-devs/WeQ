import { createHash } from 'node:crypto';
import type { CollectionItem } from '@weq/db';
import type { CollectionNetworkCursor, NetworkCollectionCursorPage } from './web/collection';

/** Canonical source hash includes fields omitted from the presentation layer. */
export function sourceVersionHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (typeof item === 'bigint') return { $bigint: item.toString() };
    if (item instanceof Uint8Array) return { $bytes: Buffer.from(item).toString('base64') };
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export interface CollectionCaptureCheckpoint {
  version: 1;
  uin: string;
  cursor: CollectionNetworkCursor | null;
  pages: number;
  observedItems: number;
  uniqueItems: number;
  seenCids: string[];
  reportedTotal: number | null;
  complete: boolean;
  incompleteReason?: 'count-mismatch';
  lastPageHash?: string;
}

export interface CollectionPageCapture {
  items: CollectionItem[];
  versions: Array<{ cid: string; sha256: string }>;
  checkpoint: CollectionCaptureCheckpoint;
  reportedTotal: number | null;
  contentCoverage: 'list-summaries';
  rawResponse: Uint8Array;
}

export interface CollectionCaptureOptions {
  checkpoint?: CollectionCaptureCheckpoint;
  maxPages?: number;
  signal?: AbortSignal;
  /** Caller commits source versions and continuation atomically, without replacing history. */
  onPage: (page: CollectionPageCapture) => Promise<void>;
}

export class CollectionCaptureError extends Error {
  constructor(
    readonly checkpoint: CollectionCaptureCheckpoint,
    cause: unknown,
  ) {
    super('收藏采集尚未完成，可从最后保存的游标继续。', { cause });
    this.name = 'CollectionCaptureError';
  }
}

/** Bounded cloud traversal; a checkpoint advances only after the sink confirms persistence. */
export async function captureCollectionPages(
  uin: string,
  readPage: (cursor: CollectionNetworkCursor | null) => Promise<NetworkCollectionCursorPage>,
  options: CollectionCaptureOptions,
): Promise<CollectionCaptureCheckpoint> {
  const initial: CollectionCaptureCheckpoint = {
    version: 1 as const,
    uin,
    cursor: null,
    pages: 0,
    observedItems: 0,
    uniqueItems: 0,
    seenCids: [],
    reportedTotal: null,
    complete: false,
  };
  let checkpoint = options.checkpoint ?? initial;
  if (
    checkpoint.version !== 1 ||
    checkpoint.uin !== uin ||
    !Number.isSafeInteger(checkpoint.pages) ||
    checkpoint.pages < 0 ||
    !Number.isSafeInteger(checkpoint.observedItems) ||
    checkpoint.observedItems < 0 ||
    !Number.isSafeInteger(checkpoint.uniqueItems) ||
    checkpoint.uniqueItems < 0 ||
    !Array.isArray(checkpoint.seenCids) ||
    checkpoint.seenCids.some((cid) => typeof cid !== 'string' || !cid) ||
    (!checkpoint.complete &&
      checkpoint.pages > 0 &&
      !checkpoint.cursor &&
      !checkpoint.incompleteReason)
  )
    throw new Error('收藏续作记录无效或属于其他账号。');
  const limit = options.maxPages ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('收藏页数上限无效。');
  try {
    // 终页计数不符后重新扫描；历史仍保留，但旧一轮观察过的 CID 不能证明新一轮完整。
    let active = checkpoint.incompleteReason === 'count-mismatch' ? initial : checkpoint;
    const seen = new Set(active.seenCids);
    for (let i = 0; i < limit && !checkpoint.complete; i++) {
      options.signal?.throwIfAborted();
      const page = await readPage(active.cursor);
      const versions = page.items.map((item) => ({
        cid: item.cid,
        sha256: sourceVersionHash(item),
      }));
      const hash = sourceVersionHash(versions);
      if (
        page.hasMore &&
        (!page.nextCursor ||
          page.items.length === 0 ||
          hash === active.lastPageHash ||
          (active.cursor && BigInt(page.nextCursor.timeStamp) >= BigInt(active.cursor.timeStamp)))
      )
        throw new Error('收藏分页没有进展，未标记完成。');
      for (const item of page.items) seen.add(item.cid);
      const reportedTotal = page.totalCount ?? active.reportedTotal;
      const countMismatch = !page.hasMore && reportedTotal !== null && seen.size !== reportedTotal;
      const next: CollectionCaptureCheckpoint = {
        ...active,
        cursor: page.nextCursor,
        pages: active.pages + 1,
        observedItems: active.observedItems + page.items.length,
        uniqueItems: seen.size,
        seenCids: [...seen],
        reportedTotal,
        complete: !page.hasMore && !countMismatch,
        ...(countMismatch ? { incompleteReason: 'count-mismatch' as const } : {}),
        lastPageHash: hash,
      };
      await options.onPage({
        items: page.items,
        versions,
        checkpoint: next,
        reportedTotal: page.totalCount,
        contentCoverage: 'list-summaries',
        rawResponse: page.rawResponse,
      });
      checkpoint = next;
      active = next;
      if (countMismatch) break;
    }
    return checkpoint;
  } catch (cause) {
    throw new CollectionCaptureError(checkpoint, cause);
  }
}
