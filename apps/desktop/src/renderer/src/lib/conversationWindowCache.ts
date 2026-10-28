import type { ConversationReadingPosition } from './conversationReadingPosition';

export interface ConversationWindow<T> {
  rows: T[];
  anchored: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  scrollTop: number;
  revision: number;
  dirty: boolean;
  storedAt: number;
  verifiedAt: number;
  prefetched?: boolean;
  readingPosition?: ConversationReadingPosition;
}

/** 只保存已有窗口，不复制媒体；来源由调用方键隔离，容量与生存期均有界。 */
export class ConversationWindowCache<T> {
  private readonly entries = new Map<
    string,
    { value: ConversationWindow<T>; bytes: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private bytes = 0;
  private readonly positions = new Map<string, ConversationReadingPosition>();
  getPosition(key: string): ConversationReadingPosition | undefined {
    return this.positions.get(key);
  }
  get(key: string): ConversationWindow<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = Date.now() - entry.value.storedAt;
    if (age < 0 || age > 10 * 60_000) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: ConversationWindow<T>, anchorIndex?: number): void {
    this.remove(key);
    if (value.readingPosition) {
      this.positions.delete(key);
      this.positions.set(key, value.readingPosition);
      if (this.positions.size > 1000) this.positions.delete(this.positions.keys().next().value!);
    }
    // 长窗口只留下阅读锚点附近的一页上下文，避免切换时序列化整段历史。
    const start = Math.max(
      0,
      Math.min((anchorIndex ?? value.rows.length - 100) - 50, value.rows.length - 200),
    );
    const end = Math.min(value.rows.length, start + 200);
    value = {
      ...value,
      rows: value.rows.slice(start, end),
      hasOlder: value.hasOlder || start > 0,
      hasNewer: value.hasNewer || end < value.rows.length,
      anchored: value.anchored && end === value.rows.length,
    };
    const entry = {
      value,
      bytes: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    this.entries.set(key, entry);
    // 切换时立即可读；体积核算移到下一轮任务，避免在 React render 中序列化消息。
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(key) !== entry) return;
      try {
        entry.bytes = new TextEncoder().encode(
          JSON.stringify(value.rows, (_key, item: unknown) =>
            typeof item === 'bigint' ? item.toString() : item,
          ),
        ).byteLength;
      } catch {
        this.remove(key);
        return;
      }
      this.bytes += entry.bytes;
      if (entry.bytes > 12 * 1024 * 1024) this.remove(key);
      this.trim();
    }, 0);
    this.trim();
  }
  private trim(): void {
    while (this.entries.size > 12 || this.bytes > 12 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
  markDirty(key?: string): void {
    if (key) {
      const entry = this.entries.get(key);
      if (entry) entry.value.dirty = true;
      return;
    }
    for (const entry of this.entries.values()) entry.value.dirty = true;
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
    this.positions.clear();
    this.bytes = 0;
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

export const conversationWindowKey = (source: string, kind: 'c2c' | 'group', conv: string) =>
  JSON.stringify([source, kind, conv]);

export function restorableConversationWindow<T>(
  cached: ConversationWindow<T> | undefined,
  readFromFirstUnread: boolean,
): ConversationWindow<T> | undefined {
  if (readFromFirstUnread && cached?.prefetched) return undefined;
  return readFromFirstUnread || cached?.anchored ? cached : undefined;
}
