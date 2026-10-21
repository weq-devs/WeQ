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
}

/** 只保存已有窗口，不复制媒体；来源由调用方键隔离，容量与生存期均有界。 */
export class ConversationWindowCache<T> {
  private readonly entries = new Map<string, { value: ConversationWindow<T>; bytes: number }>();
  private bytes = 0;
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
  put(key: string, value: ConversationWindow<T>): void {
    this.remove(key);
    if (value.rows.length > 500 || (!value.anchored && value.rows.length > 200)) return;
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(
        JSON.stringify(value.rows, (_key, item: unknown) =>
          typeof item === 'bigint' ? item.toString() : item,
        ),
      ).byteLength;
    } catch {
      return;
    }
    if (bytes > 12 * 1024 * 1024) return;
    this.entries.set(key, { value: { ...value, rows: [...value.rows] }, bytes });
    this.bytes += bytes;
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
    this.entries.clear();
    this.bytes = 0;
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

export const conversationWindowKey = (source: string, kind: 'c2c' | 'group', conv: string) =>
  JSON.stringify([source, kind, conv]);
