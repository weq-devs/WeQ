import { z } from 'zod';
import superjson from 'superjson';

const PREFIX = 'weq:page-snapshot:v1:';
const DRAFT_PREFIX = 'weq:page-draft:v1:';
export const PAGE_SNAPSHOT_MAX_BYTES = 256 * 1024;
export const PAGE_SNAPSHOT_TOTAL_BYTES = 2 * 1024 * 1024;
export const PAGE_SNAPSHOT_MAX_ENTRIES = 256;
const envelope = z.object({ savedAt: z.number().finite(), data: z.string() });
type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function belongsToScope(key: string, scope: string): boolean {
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
  return {
    resetScope(scope: string): void {
      const store = source();
      // 正文草稿独立保存；只清除该账号及其嵌套页面的可重建现场。
      for (let index = store.length - 1; index >= 0; index--) {
        const key = store.key(index);
        if (key?.startsWith(PREFIX) && belongsToScope(key.slice(PREFIX.length), scope))
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
      const raw = source().getItem((draft ? DRAFT_PREFIX : PREFIX) + key);
      if (raw === null) return undefined;
      const record = envelope.parse(JSON.parse(raw));
      return schema.parse(superjson.parse<unknown>(record.data));
    },
    write<T>(key: string, value: T, draft = false): void {
      const store = source();
      const name = (draft ? DRAFT_PREFIX : PREFIX) + key;
      const raw = JSON.stringify({ savedAt: Date.now(), data: superjson.stringify(value) });
      // localStorage 按 UTF-16 估算；额外留出键名空间。
      const bytes = (name.length + raw.length) * 2;
      if (draft) {
        // 未提交正文不参与可重建页面缓存的淘汰；写入失败由界面明确报告。
        store.setItem(name, raw);
        return;
      }
      if (bytes > PAGE_SNAPSHOT_MAX_BYTES) throw new Error('页面状态超过保存容量');
      const entries: { key: string; bytes: number; savedAt: number }[] = [];
      let total = bytes;
      for (let i = 0; i < store.length; i++) {
        const item = store.key(i);
        if (!item?.startsWith(PREFIX) || item === name) continue;
        const data = store.getItem(item);
        if (data === null) continue;
        let savedAt = 0;
        try {
          const parsed = envelope.safeParse(JSON.parse(data));
          if (parsed.success) savedAt = parsed.data.savedAt;
        } catch {
          /* 旧的损坏缓存不妨碍其它页保存。 */
        }
        const size = (item.length + data.length) * 2;
        total += size;
        entries.push({ key: item, bytes: size, savedAt });
      }
      entries.sort((a, b) => a.savedAt - b.savedAt);
      // 先确认新值可写，再淘汰旧的可重建页面现场；正文草稿另走既有专用存储。
      store.setItem(name, raw);
      while (total > PAGE_SNAPSHOT_TOTAL_BYTES || entries.length >= PAGE_SNAPSHOT_MAX_ENTRIES) {
        const oldest = entries.shift();
        if (!oldest) break;
        store.removeItem(oldest.key);
        total -= oldest.bytes;
      }
    },
  };
}

export const pageSnapshots = createPageSnapshotStorage(() => localStorage);
export const pageValue = {
  string: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
  optionalString: z.string().nullable(),
  strings: z.array(z.string()),
  stringSet: z.set(z.string()),
  stringLists: z.record(z.array(z.string())),
};
