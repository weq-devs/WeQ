import { z } from 'zod/v3';
import superjson from 'superjson';

const PREFIX = 'weq:page-snapshot:v1:';
const DRAFT_PREFIX = 'weq:page-draft:v1:';
export const PAGE_SNAPSHOT_MAX_BYTES = 256 * 1024;
export const PAGE_SNAPSHOT_TOTAL_BYTES = 2 * 1024 * 1024;
export const PAGE_SNAPSHOT_MAX_ENTRIES = 256;
const envelope = z.object({ savedAt: z.number().finite(), data: z.string() });
type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type SnapshotEntry = { bytes: number; savedAt: number };
type PendingSnapshot = { value: unknown; onError?: () => void };

export function belongsToScope(key: string, scope: string): boolean {
  let current = key;
  while (current !== scope) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return false;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string')
      return false;
    current = parsed[0];
  }
  return true;
}

/** 仅保存显式登记的页面数据；不持有 DOM、ReactNode 或媒体对象。 */
export function createPageSnapshotStorage(source: () => SnapshotStorage) {
  const pending = new Map<string, PendingSnapshot>();
  let cancelFlush: (() => void) | undefined;
  let index:
    | { store: SnapshotStorage; length: number; entries: Map<string, SnapshotEntry>; bytes: number }
    | undefined;

  function writeSnapshot(store: SnapshotStorage, name: string, value: unknown, draft: boolean) {
    const savedAt = Date.now();
    const raw = JSON.stringify({ savedAt, data: superjson.stringify(value) });
    // localStorage 按 UTF-16 估算；额外留出键名空间。
    const bytes = (name.length + raw.length) * 2;
    if (draft) {
      store.setItem(name, raw);
      return;
    }
    if (bytes > PAGE_SNAPSHOT_MAX_BYTES) throw new Error('页面状态超过保存容量');
    if (index?.store !== store || index.length !== store.length) {
      const entries = new Map<string, SnapshotEntry>();
      let total = 0;
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        const data = store.getItem(key);
        if (data === null) continue;
        let time = 0;
        try {
          time = envelope.parse(JSON.parse(data)).savedAt;
        } catch {
          /* 旧的损坏缓存不妨碍其它页保存。 */
        }
        const size = (key.length + data.length) * 2;
        entries.set(key, { bytes: size, savedAt: time });
        total += size;
      }
      index = { store, length: store.length, entries, bytes: total };
    }
    // 确认新值可写后才淘汰；草稿不参与页面快照淘汰。
    store.setItem(name, raw);
    index.bytes += bytes - (index.entries.get(name)?.bytes ?? 0);
    index.entries.set(name, { bytes, savedAt });
    if (index.bytes > PAGE_SNAPSHOT_TOTAL_BYTES || index.entries.size > PAGE_SNAPSHOT_MAX_ENTRIES) {
      const oldest = [...index.entries].sort((a, b) => a[1].savedAt - b[1].savedAt);
      for (const [key, entry] of oldest) {
        if (
          index.bytes <= PAGE_SNAPSHOT_TOTAL_BYTES &&
          index.entries.size <= PAGE_SNAPSHOT_MAX_ENTRIES
        )
          break;
        if (key === name) continue;
        store.removeItem(key);
        index.entries.delete(key);
        index.bytes -= entry.bytes;
      }
    }
    index.length = store.length;
  }

  function flush() {
    cancelFlush?.();
    cancelFlush = undefined;
    const writes = [...pending];
    pending.clear();
    for (const [key, entry] of writes) {
      try {
        writeSnapshot(source(), PREFIX + key, entry.value, false);
      } catch {
        entry.onError?.();
      }
    }
  }

  return {
    flush,
    invalidateIndex(): void {
      index = undefined;
    },
    scheduleWrite(key: string, value: unknown, onError?: () => void): void {
      pending.delete(key);
      pending.set(key, { value, onError });
      if (cancelFlush) return;
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(flush, { timeout: 500 });
        cancelFlush = () => window.cancelIdleCallback(id);
      } else {
        const timer = window.setTimeout(flush, 50);
        cancelFlush = () => window.clearTimeout(timer);
      }
    },
    hasDrafts(scope: string): boolean {
      const store = source();
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index);
        if (key?.startsWith(DRAFT_PREFIX) && belongsToScope(key.slice(DRAFT_PREFIX.length), scope))
          return true;
      }
      return false;
    },
    resetScope(scope: string, discardDrafts = false): void {
      for (const key of pending.keys()) if (belongsToScope(key, scope)) pending.delete(key);
      index = undefined;
      const store = source();
      // 默认保留正文草稿，只有用户明确放弃时才一并清除。
      for (let index = store.length - 1; index >= 0; index--) {
        const key = store.key(index);
        if (
          key &&
          ((key.startsWith(PREFIX) && belongsToScope(key.slice(PREFIX.length), scope)) ||
            (discardDrafts &&
              key.startsWith(DRAFT_PREFIX) &&
              belongsToScope(key.slice(DRAFT_PREFIX.length), scope)))
        )
          store.removeItem(key);
      }
    },
    confirm(key: string, value: unknown): void {
      const store = source();
      const name = DRAFT_PREFIX + key;
      const raw = store.getItem(name);
      if (raw !== null && envelope.parse(JSON.parse(raw)).data === superjson.stringify(value))
        store.removeItem(name);
    },
    read<T>(key: string, schema: z.ZodType<T>, draft = false): T | undefined {
      const queued = draft ? undefined : pending.get(key);
      if (queued) return schema.parse(queued.value);
      const raw = source().getItem((draft ? DRAFT_PREFIX : PREFIX) + key);
      if (raw === null) return undefined;
      const record = envelope.parse(JSON.parse(raw));
      return schema.parse(superjson.parse<unknown>(record.data));
    },
    remove(key: string): void {
      pending.delete(key);
      index = undefined;
      source().removeItem(PREFIX + key);
    },
    write<T>(key: string, value: T, draft = false): void {
      if (!draft) pending.delete(key);
      writeSnapshot(source(), (draft ? DRAFT_PREFIX : PREFIX) + key, value, draft);
    },
  };
}

export const pageSnapshots = createPageSnapshotStorage(() => localStorage);
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', pageSnapshots.flush);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pageSnapshots.flush();
  });
  window.addEventListener('storage', (event) => {
    if (event.storageArea === localStorage && (!event.key || event.key.startsWith(PREFIX)))
      pageSnapshots.invalidateIndex();
  });
}
export const pageValue = {
  string: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
  optionalString: z.string().nullable(),
  strings: z.array(z.string()),
  stringSet: z.set(z.string()),
  stringLists: z.record(z.array(z.string())),
};
