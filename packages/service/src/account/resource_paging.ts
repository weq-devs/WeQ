/**
 * Shared paging machinery for the local-resource browsers (avatar / emoji /
 * media caches …). Every resource service pages its directory listing the same
 * way: a bounded page size and an opaque cursor that is either a plain index
 * into a sorted list, or a `"<bucketIndex>:<entryIndex>"` position while
 * walking buckets.
 *
 * These helpers (plus the page constants) used to be copied verbatim into every
 * service (`clampInt`, `parseCursor`, `DEFAULT_PAGE`, `MAX_PAGE`…); the cursor
 * walks themselves were duplicated loops as well. `pageByIndex` / `walkBuckets`
 * centralize the walks so each service only supplies its own listing logic.
 */

/** Default page size for the resource browsers. */
export const DEFAULT_PAGE = 120;

/** Hard cap on any single page — guards against absurd `limit` values. */
export const MAX_PAGE = 500;

/** Bounds for {@link clampLimit}. */
export interface PageLimitOpts {
  /** Lower bound (default 1 — a page must be non-empty). */
  lo?: number;
  /** Upper bound (default {@link MAX_PAGE}). */
  hi?: number;
  /** Value used when `limit` is absent / not a finite number (default {@link DEFAULT_PAGE}). */
  fallback?: number;
}

/** Clamp a requested page size to `[lo, hi]`, defaulting when absent / invalid. */
export function clampLimit(limit: number | undefined, opts: PageLimitOpts = {}): number {
  const lo = opts.lo ?? 1;
  const hi = opts.hi ?? MAX_PAGE;
  const fb = opts.fallback ?? DEFAULT_PAGE;
  const x = Math.floor(typeof limit === 'number' && Number.isFinite(limit) ? limit : fb);
  return Math.min(hi, Math.max(lo, x));
}

/** A page sliced by an index cursor. */
export interface IndexPage<T> {
  entries: T[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Total items in the set (handy for a header count). */
  total: number;
}

/**
 * Slice `items` for one page. The cursor is the next index to read, so paging
 * is stable and resumable as long as the underlying set doesn't change between
 * calls. `total` is the set's size at slice time.
 */
export function pageByIndex<T>(
  items: readonly T[],
  opts: { limit?: number; cursor?: string | null } = {},
): IndexPage<T> {
  const cap = clampLimit(opts.limit);
  const start = Math.max(0, Number(opts.cursor ?? 0) || 0);
  const entries = items.slice(start, start + cap);
  const nextIndex = start + entries.length;
  return {
    entries,
    nextCursor: nextIndex < items.length ? String(nextIndex) : null,
    total: items.length,
  };
}

/** Position inside a bucket walk, encoded as `"<bucketIndex>:<entryIndex>"`. */
export interface BucketCursor {
  bucketIndex: number;
  entryIndex: number;
}

/** Parse a bucket cursor string, or the walk's start position when absent. */
export function parseBucketCursor(cursor: string | null): BucketCursor {
  if (!cursor) return { bucketIndex: 0, entryIndex: 0 };
  const [b, e] = cursor.split(':');
  return {
    bucketIndex: Math.max(0, Number(b) || 0),
    entryIndex: Math.max(0, Number(e) || 0),
  };
}

/**
 * Walk buckets in order, collecting up to `limit` entries across them. `load` is
 * the service's per-bucket listing — it MUST return its items already sorted
 * (by whatever ordering the service wants to surface), because the resume
 * cursor points into that exact order: readdir order is not guaranteed stable,
 * so a cursor could land on a different entry across calls otherwise.
 *
 * Returns the page plus the resume cursor, or null when every bucket is
 * exhausted, mirroring the `"{bucketIndex}:{entryIndex}"` shape the renderer's
 * infinite-scroll hook already consumes.
 */
export async function walkBuckets<T>(
  buckets: readonly string[],
  start: BucketCursor,
  limit: number,
  load: (bucket: string, index: number) => Promise<readonly T[]>,
): Promise<{ entries: T[]; nextCursor: string | null }> {
  const entries: T[] = [];
  let bucketIndex = start.bucketIndex;
  let entryIndex = start.entryIndex;

  while (bucketIndex < buckets.length && entries.length < limit) {
    const bucket = buckets[bucketIndex]!;
    const items = await load(bucket, bucketIndex);

    for (; entryIndex < items.length && entries.length < limit; entryIndex += 1) {
      entries.push(items[entryIndex]!);
    }

    if (entryIndex < items.length) {
      // Filled the page mid-bucket — resume here next call.
      return { entries, nextCursor: `${bucketIndex}:${entryIndex}` };
    }
    // Bucket exhausted; advance to the next one.
    bucketIndex += 1;
    entryIndex = 0;
  }

  const done = bucketIndex >= buckets.length;
  return { entries, nextCursor: done ? null : `${bucketIndex}:${entryIndex}` };
}
