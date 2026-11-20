export interface StoredAvatar {
  key: string;
  blob: Blob;
  etag: string | null;
  updatedAt: number;
}
export interface AvatarStore {
  get(key: string): Promise<StoredAvatar | undefined>;
  put(value: StoredAvatar): Promise<void>;
}
export const WEB_AVATAR_LIMITS = {
  freshMs: 5 * 60_000,
  retryMs: 30_000,
  maxImages: 192,
  maxBytes: 32 * 1024 * 1024,
  maxBlobBytes: 2 * 1024 * 1024,
  diskImages: 512,
  diskBytes: 24 * 1024 * 1024,
  concurrent: 4,
};
const MISSING_AVATAR_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open('weq-avatar-cache', 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore('images', { keyPath: 'key' })
        .createIndex('updatedAt', 'updatedAt');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(new Error('头像缓存不可用'));
    };
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}
export const avatarStore: AvatarStore = {
  async get(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(key);
      request.onsuccess = () => resolve(request.result as StoredAvatar | undefined);
      request.onerror = () => reject(new Error('头像缓存读取失败'));
    });
  },
  async put(value) {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      store.put(value);
      let count = 0,
        bytes = 0;
      const cursor = store.index('updatedAt').openCursor(null, 'prev');
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        bytes += (row.value as StoredAvatar).blob.size;
        if (++count > WEB_AVATAR_LIMITS.diskImages || bytes > WEB_AVATAR_LIMITS.diskBytes)
          row.delete();
        row.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('头像缓存保存失败'));
    });
  },
};

/** 来源、账号、配置和图像规格隔离；刷新戳与客户端标识不是图片身份。 */
export function webAvatarKey(scope: string, source: string): string | null {
  if (!source.startsWith('/')) return null;
  const url = new URL(source, 'https://weq.invalid');
  if (!['/_media/avatar', '/_avatar/fetch'].includes(url.pathname)) return null;
  for (const key of ['cid', '_weq_avatar_refresh', '_weq_avatar_remote'])
    url.searchParams.delete(key);
  url.searchParams.sort();
  return JSON.stringify([scope, url.pathname + url.search]);
}

interface PreparedAvatar {
  src: string;
  bytes: number;
  dispose(): void;
}
export interface AvatarSnapshot {
  src: string | undefined;
  ready: boolean;
  failed: boolean;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('头像读取已取消', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function prepareAvatar(blob: Blob): Promise<PreparedAvatar> {
  const src = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = src;
    await image.decode();
    const bytes = image.naturalWidth * image.naturalHeight * 4;
    if (!bytes || bytes > WEB_AVATAR_LIMITS.maxBytes) throw new Error('头像尺寸超出缓存预算');
    return {
      src,
      bytes,
      dispose() {
        image.removeAttribute('src');
        URL.revokeObjectURL(src);
      },
    };
  } catch (error) {
    image.removeAttribute('src');
    URL.revokeObjectURL(src);
    throw error;
  }
}

/** 仅加载实际显示的头像；旧图先发布，网络与解码完成后再替换。 */
export function createWebAvatarCache({
  store = avatarStore,
  fetchImage = (source: string, init: RequestInit) => fetch(source, init),
  prepare = prepareAvatar,
  now = Date.now,
} = {}) {
  type Entry = {
    value?: StoredAvatar;
    image?: PreparedAvatar;
    snapshot: AvatarSnapshot;
    request?: string;
    retryAt: number;
  };
  type Visibility = { count: number; retries: number; timer?: ReturnType<typeof setTimeout> };
  type Job = {
    source: string;
    controller: AbortController;
    promise: Promise<void>;
    retryView?: Visibility;
  };
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const visible = new Map<string, Visibility>();
  const jobs = new Map<string, Job>();
  const queue: (() => void)[] = [];
  let active = 0;
  const notify = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const trim = () => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.image?.bytes ?? 0), 0);
    for (const [key, entry] of entries) {
      if (entries.size <= WEB_AVATAR_LIMITS.maxImages && bytes <= WEB_AVATAR_LIMITS.maxBytes) break;
      if (visible.has(key) || jobs.has(key)) continue;
      entries.delete(key);
      bytes -= entry.image?.bytes ?? 0;
      entry.image?.dispose();
      notify(key);
    }
  };
  const publish = (key: string, entry: Entry) => {
    entries.delete(key);
    entries.set(key, entry);
    notify(key);
    trim();
  };
  const run = (work: () => Promise<void>) =>
    new Promise<void>((resolve) => {
      const start = () => {
        active++;
        void work().finally(() => {
          active--;
          resolve();
          queue.shift()?.();
        });
      };
      if (active < WEB_AVATAR_LIMITS.concurrent) start();
      else queue.push(start);
    });
  const cancelRetry = (view: Visibility) => {
    clearTimeout(view.timer);
    view.timer = undefined;
  };
  const scheduleRetry = (key: string, source: string, failed: Entry) => {
    const view = visible.get(key);
    if (!view || view.retries >= MISSING_AVATAR_RETRY_DELAYS_MS.length || view.timer !== undefined)
      return;
    view.timer = setTimeout(
      () => {
        view.timer = undefined;
        if (visible.get(key) !== view || entries.get(key) !== failed) return;
        view.retries++;
        void cache.load(key, source, view);
      },
      Math.max(0, failed.retryAt - now()),
    );
  };
  const cache = {
    activate(key: string) {
      const view = visible.get(key) ?? { count: 0, retries: 0 };
      visible.set(key, view);
      view.count++;
      return () => {
        if (--view.count === 0) {
          cancelRetry(view);
          const job = jobs.get(key);
          if (job?.retryView === view) job.controller.abort();
          visible.delete(key);
        }
        trim();
      };
    },
    peek(key: string) {
      return entries.get(key)?.snapshot;
    },
    subscribe(key: string, listener: () => void) {
      let group = listeners.get(key);
      if (!group) {
        group = new Set();
        listeners.set(key, group);
      }
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) {
          listeners.delete(key);
          jobs.get(key)?.controller.abort();
          trim();
        }
      };
    },
    load(key: string, source: string, retryView?: Visibility): Promise<void> {
      const existing = jobs.get(key);
      if (existing?.source === source && !existing.controller.signal.aborted)
        return existing.promise;
      const cached = entries.get(key);
      const force = new URL(source, 'https://weq.invalid').searchParams.has('_weq_avatar_refresh');
      if (
        cached &&
        (!force || cached.request === source) &&
        (cached.retryAt > now() ||
          (cached.value && now() - cached.value.updatedAt < WEB_AVATAR_LIMITS.freshMs))
      ) {
        if (cached.snapshot.failed) scheduleRetry(key, source, cached);
        entries.delete(key);
        entries.set(key, cached);
        return Promise.resolve();
      }
      const view = visible.get(key);
      if (view) cancelRetry(view);
      existing?.controller.abort();
      const controller = new AbortController();
      const job: Job = { source, controller, promise: Promise.resolve(), retryView };
      jobs.set(key, job);
      const current = () => !controller.signal.aborted && jobs.get(key) === job;
      job.promise = run(async () => {
        if (!current()) return;
        let entry = entries.get(key);
        const install = async (value: StoredAvatar) => {
          const preparing = prepare(value.blob);
          void preparing.then(
            (image) => {
              if (!current()) image.dispose();
            },
            () => {},
          );
          const image = await abortable(preparing, controller.signal);
          if (!current()) {
            image.dispose();
            return;
          }
          const old = entry?.image;
          entry = {
            value,
            image,
            snapshot: { src: image.src, ready: true, failed: false },
            request: source,
            retryAt: 0,
          };
          publish(key, entry);
          old?.dispose();
        };
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 15_000);
        try {
          if (!entry?.value) {
            // 私有存储被系统占用时直接继续在线读取，不拖住头像队列。
            let diskTimer: ReturnType<typeof setTimeout> | undefined;
            const stored = await abortable(
              Promise.race([
                store.get(key).catch(() => undefined),
                new Promise<undefined>((resolve) => {
                  diskTimer = setTimeout(() => resolve(undefined), 200);
                }),
              ]),
              controller.signal,
            ).finally(() => clearTimeout(diskTimer));
            if (!current()) return;
            if (
              stored?.key === key &&
              stored.blob?.size > 0 &&
              stored.blob.size <= WEB_AVATAR_LIMITS.maxBlobBytes
            ) {
              try {
                await install(stored);
              } catch (error) {
                if (controller.signal.aborted) throw error;
                /* 损坏的缓存不阻止在线读取。 */
              }
            }
          }
          if (!current()) return;
          if (!force && entry?.value && now() - entry.value.updatedAt < WEB_AVATAR_LIMITS.freshMs)
            return;
          const response = await abortable(
            fetchImage(source, {
              cache: 'no-store',
              signal: controller.signal,
              headers: !force && entry?.value?.etag ? { 'If-None-Match': entry.value.etag } : {},
            }),
            controller.signal,
          );
          if (!current()) return;
          let value: StoredAvatar;
          if (response.status === 304 && entry?.value) value = { ...entry.value, updatedAt: now() };
          else {
            if (!response.ok) throw new Error('头像请求失败');
            if (Number(response.headers.get('content-length')) > WEB_AVATAR_LIMITS.maxBlobBytes)
              throw new Error('头像文件过大');
            const blob = await abortable(response.blob(), controller.signal);
            if (
              !blob.size ||
              blob.size > WEB_AVATAR_LIMITS.maxBlobBytes ||
              !blob.type.startsWith('image/')
            )
              throw new Error('头像格式不可缓存');
            value = { key, blob, etag: response.headers.get('etag'), updatedAt: now() };
          }
          if (!current()) return;
          if (response.status === 304 && entry) {
            entry.value = value;
            entry.request = source;
            entry.retryAt = 0;
          } else await install(value);
          if (current()) void store.put(value).catch(() => {});
        } catch {
          if (jobs.get(key) !== job || (!current() && !timedOut)) return;
          if (entry?.value) entry.retryAt = now() + WEB_AVATAR_LIMITS.retryMs;
          else {
            const retries = visible.get(key)?.retries ?? 0;
            const delay = MISSING_AVATAR_RETRY_DELAYS_MS[retries] ?? WEB_AVATAR_LIMITS.retryMs;
            const failed = {
              snapshot: { src: undefined, ready: false, failed: true },
              request: source,
              retryAt: now() + delay,
            };
            publish(key, failed);
            scheduleRetry(key, source, failed);
          }
        } finally {
          clearTimeout(timeout);
        }
      }).finally(() => {
        if (jobs.get(key) === job) jobs.delete(key);
        trim();
      });
      return job.promise;
    },
  };
  return cache;
}

export const webAvatarCache = createWebAvatarCache();
