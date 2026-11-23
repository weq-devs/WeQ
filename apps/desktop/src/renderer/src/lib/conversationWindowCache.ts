import type { ConversationReadingPosition } from './conversationReadingPosition';

export const CONVERSATION_WINDOW_LIMIT = 12;

export interface ConversationWindow<T> {
  rows: T[];
  anchored: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
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
    {
      value: ConversationWindow<T>;
      speculative: boolean;
      bytes: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private bytes = 0;
  private clock = 0;
  private allChangedAt = 0;
  private unknownChangedAt = 0;
  private readonly changes = new Map<string, number>();
  private readonly positions = new Map<string, ConversationReadingPosition>();
  get revision(): number {
    return this.clock;
  }
  changedSince(key: string, revision: number): boolean {
    return revision < Math.max(this.allChangedAt, this.changes.get(key) ?? 0);
  }
  unknownChangeSince(revision: number): boolean {
    return revision < this.unknownChangedAt;
  }
  getPosition(key: string): ConversationReadingPosition | undefined {
    return this.positions.get(key);
  }
  setPosition(key: string, position: ConversationReadingPosition | undefined): void {
    this.positions.delete(key);
    if (!position) return;
    this.positions.set(key, position);
    if (this.positions.size > 1000) this.positions.delete(this.positions.keys().next().value!);
  }
  /** 后台检查不算用户访问，避免预取改变已阅读窗口的 LRU 顺序。 */
  peek(key: string): ConversationWindow<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = Date.now() - entry.value.storedAt;
    if (age < 0 || age > 10 * 60_000) {
      this.remove(key);
      return undefined;
    }
    return entry.value;
  }
  get(key: string): ConversationWindow<T> | undefined {
    const value = this.peek(key);
    const entry = this.entries.get(key);
    if (!value || !entry) return undefined;
    entry.speculative = false;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return value;
  }
  canPrefetch(key: string): boolean {
    for (const candidate of this.entries.keys()) this.peek(candidate);
    return (
      this.entries.has(key) ||
      this.entries.size < CONVERSATION_WINDOW_LIMIT ||
      [...this.entries.values()].some((entry) => entry.speculative)
    );
  }
  put(key: string, value: ConversationWindow<T>, anchorIndex?: number): void {
    const speculative = value.prefetched === true && (this.entries.get(key)?.speculative ?? true);
    this.remove(key);
    if (value.readingPosition) this.setPosition(key, value.readingPosition);
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
      speculative,
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
    while (this.entries.size > CONVERSATION_WINDOW_LIMIT || this.bytes > 12 * 1024 * 1024) {
      const oldest =
        [...this.entries].find(([, entry]) => entry.speculative)?.[0] ??
        this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
  markDirty(key?: string): void {
    this.clock++;
    if (key) {
      this.markKey(key);
      return;
    }
    this.allChangedAt = this.clock;
    this.changes.clear();
    for (const entry of this.entries.values()) entry.value.dirty = true;
  }
  noteUnknownChange(activeKey?: string): void {
    this.unknownChangedAt = ++this.clock;
    if (activeKey) this.markKey(activeKey);
  }
  private markKey(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.value.dirty = true;
    this.changes.delete(key);
    this.changes.set(key, this.clock);
    if (this.changes.size > 256) {
      const oldest = this.changes.keys().next().value!;
      // 淘汰的标记仍能使更早发出的读失效，避免迟到结果把过期数据当成新数据。
      this.allChangedAt = Math.max(this.allChangedAt, this.changes.get(oldest)!);
      this.changes.delete(oldest);
    }
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
    this.positions.clear();
    this.changes.clear();
    this.allChangedAt = this.unknownChangedAt = this.clock = 0;
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
  position?: ConversationReadingPosition,
): ConversationWindow<T> | undefined {
  if (position) {
    // 范围曾因打开最新消息或预取而被替换时，按保存的消息重新读取。
    return cached?.readingPosition === position ? cached : undefined;
  }
  return cached?.anchored ? cached : undefined;
}
