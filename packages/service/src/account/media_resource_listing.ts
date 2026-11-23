import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const STAT_LIMIT = 16;
let activeStats = 0;
const waiting = new Set<() => void>();

// 共享额度。每个目录只排一小批 stat，聊天的文件查找可以插入 libuv 队列。
async function mediaStat(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (activeStats >= STAT_LIMIT) {
    await new Promise<void>((grant, reject) => {
      const cancel = () => {
        waiting.delete(start);
        reject(signal?.reason);
      };
      const start = () => {
        waiting.delete(start);
        signal?.removeEventListener('abort', cancel);
        grant();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      waiting.add(start);
    });
  } else activeStats++;
  try {
    signal?.throwIfAborted();
    return await lstat(path);
  } finally {
    const next = waiting.values().next().value;
    if (next) next();
    else activeStats--;
  }
}

export async function mediaFileNames(dir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  signal?.throwIfAborted();
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

export interface MediaFileEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

export async function readMediaFileStats(
  dir: string,
  names: readonly string[],
  signal?: AbortSignal,
) {
  let next = 0;
  const entries = new Array<MediaFileEntry | undefined>(names.length);
  await Promise.all(
    Array.from({ length: Math.min(STAT_LIMIT, names.length) }, async () => {
      while (next < names.length) {
        const index = next++;
        const name = names[index]!;
        const info = await mediaStat(join(dir, name), signal).catch(() => undefined);
        signal?.throwIfAborted();
        if (info?.isFile()) entries[index] = { name, size: info.size, mtimeMs: info.mtimeMs };
      }
    }),
  );
  return entries.filter((entry): entry is MediaFileEntry => entry !== undefined);
}

async function directoryRevision(paths: readonly string[], signal?: AbortSignal) {
  const revisions = await Promise.all(
    paths.map(async (path) => {
      try {
        const st = await mediaStat(path, signal);
        return [st.dev, st.ino, st.mtimeMs, st.ctimeMs];
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : undefined;
      }
    }),
  );
  signal?.throwIfAborted();
  if (revisions.every((version) => version !== undefined)) return JSON.stringify(revisions);
}

const ROW_WINDOW = 16_000;
const ROW_CACHE_BUDGET = 2 * ROW_WINDOW;
const SNAPSHOT_TTL = 15_000;

type Snapshot<T> = {
  total: number;
  offset: number;
  revision: string;
  expires: number;
  generation: number;
  rows: T[];
};

/** 保留排序结果，不持有文件描述符。首屏重开重新观察文件内部的 mtime 变化。 */
export class MediaBucketPages<T> {
  private readonly cache = new Map<string, Snapshot<T>>();
  private rowCount = 0;
  private generation = 0;
  private expiry?: ReturnType<typeof setTimeout>;

  async page(
    dirs: string[],
    offset: number,
    limit: number,
    resume: boolean,
    load: () => Promise<T[]>,
    signal?: AbortSignal,
  ): Promise<{ entries: T[]; nextOffset: number | null }> {
    const key = JSON.stringify(dirs);
    const generation = ++this.generation;
    this.pruneExpired();
    const revision = await directoryRevision(dirs, signal);
    const cached = this.cache.get(key);
    if (
      resume &&
      cached &&
      cached.revision === revision &&
      cached.expires > Date.now() &&
      offset >= cached.offset &&
      Math.min(cached.total, offset + limit) <= cached.offset + cached.rows.length
    ) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      const start = offset - cached.offset;
      return {
        entries: cached.rows.slice(start, start + limit),
        nextOffset: offset + limit < cached.total ? offset + limit : null,
      };
    }

    const rows = await load();
    signal?.throwIfAborted();
    const stable =
      revision !== undefined && rows.length && revision === (await directoryRevision(dirs, signal));
    const current = this.cache.get(key);
    if (stable && (!current || current.generation <= generation)) {
      // 超大月份仍给接下来的页保留一段窗口，避免突破进程内的快照预算。
      const from = rows.length > ROW_WINDOW ? offset : 0;
      const window = rows.slice(from, from + ROW_WINDOW);
      this.remove(key);
      while (this.cache.size >= 8 || this.rowCount + window.length > ROW_CACHE_BUDGET) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.remove(oldest);
      }
      this.cache.set(key, {
        total: rows.length,
        offset: from,
        revision,
        expires: Date.now() + SNAPSHOT_TTL,
        generation,
        rows: window,
      });
      this.rowCount += window.length;
      this.scheduleExpiry();
    } else if (current && current.generation <= generation && current.revision !== revision)
      this.remove(key);
    return {
      entries: rows.slice(offset, offset + limit),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [id, snapshot] of this.cache) if (snapshot.expires <= now) this.remove(id);
  }

  private scheduleExpiry() {
    clearTimeout(this.expiry);
    if (!this.cache.size) return;
    const next = Math.min(...[...this.cache.values()].map(({ expires }) => expires));
    this.expiry = setTimeout(
      () => {
        this.pruneExpired();
        this.scheduleExpiry();
      },
      Math.max(1, next - Date.now()),
    );
    this.expiry.unref?.();
  }

  private remove(key: string) {
    this.rowCount -= this.cache.get(key)?.rows.length ?? 0;
    this.cache.delete(key);
  }
}
