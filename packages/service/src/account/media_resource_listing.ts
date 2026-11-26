import { watch, type FSWatcher } from 'node:fs';
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

async function directoryStamp(path: string, signal?: AbortSignal) {
  try {
    const st = await mediaStat(path, signal);
    return st.isDirectory() ? ([st.dev, st.ino, st.mtimeMs, st.ctimeMs] as const) : 'missing';
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : undefined;
  }
}

async function directoryRevision(paths: readonly string[], signal?: AbortSignal) {
  const revisions = await Promise.all(paths.map((path) => directoryStamp(path, signal)));
  signal?.throwIfAborted();
  if (revisions.every((version) => version !== undefined)) return JSON.stringify(revisions);
}

const FILE_INDEX_TTL = 60_000;
const FILE_INDEX_LIMIT = 128_000;
type DirectoryIndex = {
  epoch: number;
  generation: number;
  verified: number;
  expires: number;
  identity?: string;
  revision?: string;
  missing?: boolean;
  files?: Map<string, MediaFileEntry>;
  watcher?: FSWatcher;
  dirty: Set<string>;
  relist: boolean;
  rescan: boolean;
};

/** 缓存每月文件元数据。文件变更只复查受影响的名称，丢失通知时定期完整校准。 */
export class MediaDirectoryIndex {
  private readonly dirs = new Map<string, DirectoryIndex>();
  private epoch = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private closed = false;

  version(paths: readonly string[]) {
    const now = Date.now();
    const versions: string[] = [];
    for (const path of paths) {
      const state = this.dirs.get(path);
      if (
        !state ||
        state.expires <= now ||
        state.verified !== state.generation ||
        (!state.watcher && !state.missing)
      )
        return;
      versions.push(`${state.epoch}:${state.verified}`);
    }
    return versions.join('/');
  }

  async read(path: string, signal?: AbortSignal): Promise<MediaFileEntry[]> {
    const stamp = await directoryStamp(path, signal);
    signal?.throwIfAborted();
    if (this.closed || !stamp)
      return readMediaFileStats(path, await mediaFileNames(path, signal), signal);
    this.prune();
    const identity = typeof stamp === 'string' ? stamp : `${stamp[0]}:${stamp[1]}`;
    let state = this.dirs.get(path);
    if (state?.identity !== identity) {
      this.forget(path);
      while (this.dirs.size >= 12) this.forget(this.dirs.keys().next().value!);
      state = {
        epoch: ++this.epoch,
        generation: 0,
        verified: -1,
        expires: Date.now() + FILE_INDEX_TTL,
        identity,
        missing: stamp === 'missing',
        dirty: new Set(),
        relist: false,
        rescan: false,
      };
      this.dirs.set(path, state);
      if (!state.missing) this.watch(path, state);
      this.scheduleExpiry();
    }
    if (state.missing) {
      state.verified = state.generation;
      return [];
    }

    const revision = JSON.stringify(stamp);
    const generation = state.generation;
    const changed = state.relist || state.revision !== revision;
    const dirty = new Set(state.dirty);
    // 无名通知、目录换代或监视失败时，保留完整读取作为兜底。
    const previous =
      state.watcher && !state.rescan && (!changed || dirty.size) ? state.files : undefined;
    if (previous && !changed && !dirty.size) return [...previous.values()];
    const names = previous && !changed ? [...previous.keys()] : await mediaFileNames(path, signal);
    const changedNames = previous
      ? names.filter((name) => !previous.has(name) || dirty.has(name))
      : names;
    const stats = await readMediaFileStats(path, changedNames, signal);
    signal?.throwIfAborted();
    const next = new Map(stats.map((item) => [item.name, item]));
    if (previous)
      for (const name of names) {
        const item = previous.get(name);
        if (item && !dirty.has(name)) next.set(name, item);
      }
    if (this.dirs.get(path) === state && state.verified <= generation) {
      state.files = next;
      state.revision = revision;
      state.verified = generation;
      if (state.generation === generation) {
        state.dirty.clear();
        state.relist = false;
        state.rescan = false;
      }
      this.dirs.delete(path);
      this.dirs.set(path, state);
      let total = [...this.dirs.values()].reduce((sum, item) => sum + (item.files?.size ?? 0), 0);
      while (total > FILE_INDEX_LIMIT) {
        const oldest = this.dirs.keys().next().value!;
        total -= this.dirs.get(oldest)?.files?.size ?? 0;
        this.forget(oldest);
      }
    }
    return [...next.values()];
  }

  private watch(path: string, state: DirectoryIndex) {
    try {
      const watcher = watch(path, { persistent: false }, (event, filename) => {
        state.generation++;
        if (event === 'rename') state.relist = true;
        if (!filename || state.dirty.size >= 4096) {
          state.dirty.clear();
          state.rescan = true;
        } else state.dirty.add(filename);
      });
      state.watcher = watcher;
      watcher.on('error', () => this.forget(path, state));
    } catch {
      // 某些卷不支持监视，照常分页读取。
    }
  }

  private forget(path: string, expected?: DirectoryIndex) {
    const state = this.dirs.get(path);
    if (expected && state !== expected) return;
    this.dirs.delete(path);
    state?.watcher?.close();
  }

  private prune() {
    const now = Date.now();
    for (const [path, state] of this.dirs) if (state.expires <= now) this.forget(path);
  }

  private scheduleExpiry() {
    clearTimeout(this.expiry);
    if (!this.dirs.size) return;
    const next = Math.min(...[...this.dirs.values()].map(({ expires }) => expires));
    this.expiry = setTimeout(
      () => {
        this.prune();
        this.scheduleExpiry();
      },
      Math.max(1, next - Date.now()),
    );
    this.expiry.unref?.();
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.expiry);
    for (const path of this.dirs.keys()) this.forget(path);
  }
}

const ROW_WINDOW = 16_000;
const ROW_CACHE_BUDGET = 2 * ROW_WINDOW;
const SNAPSHOT_TTL = 15_000;

type Snapshot<T> = {
  total: number;
  offset: number;
  revision: string;
  contentRevision?: string;
  expires: number;
  generation: number;
  rows: T[];
};

/** 分页复用同版本的排序结果，重开首屏也走索引。 */
export class MediaBucketPages<T> {
  private readonly cache = new Map<string, Snapshot<T>>();
  private rowCount = 0;
  private generation = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly directoryIndex?: MediaDirectoryIndex) {}

  async page(
    dirs: string[],
    offset: number,
    limit: number,
    resume: boolean,
    load: () => Promise<T[]>,
    signal?: AbortSignal,
    observedIndex = false,
  ): Promise<{ entries: T[]; nextOffset: number | null }> {
    const key = JSON.stringify(dirs);
    const generation = ++this.generation;
    this.pruneExpired();
    const revision = await directoryRevision(dirs, signal);
    const contentRevision = observedIndex ? this.directoryIndex?.version(dirs) : undefined;
    const cached = this.cache.get(key);
    if (
      (resume || contentRevision !== undefined) &&
      cached &&
      cached.revision === revision &&
      cached.contentRevision === contentRevision &&
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
    const confirmedContent = observedIndex ? this.directoryIndex?.version(dirs) : undefined;
    const current = this.cache.get(key);
    if (stable && !this.closed && (!current || current.generation <= generation)) {
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
        contentRevision: confirmedContent,
        expires: Date.now() + (confirmedContent === undefined ? SNAPSHOT_TTL : FILE_INDEX_TTL),
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

  dispose() {
    this.closed = true;
    clearTimeout(this.expiry);
    for (const key of this.cache.keys()) this.remove(key);
  }
}
