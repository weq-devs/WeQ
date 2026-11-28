/** 快速往返列表时复用刚完成的读取，手动刷新仍可立即发起。 */
export const PAGE_REENTRY_STALE_MS = 15_000;

export function isRecentPageRead(checkedAt: number, now = Date.now()): boolean {
  const age = now - checkedAt;
  return checkedAt > 0 && age >= 0 && age < PAGE_REENTRY_STALE_MS;
}

/** 仅保存服务器 DTO，不保留页面、DOM 或媒体节点；账号切换随 Provider 一起释放。 */
export class PageDataCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number; savedAt: number }>();
  private bytes = 0;
  constructor(
    private readonly maxEntries = 24,
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly maxAge = 5 * 60_000,
  ) {}
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = Date.now() - entry.savedAt;
    if (age < 0 || age > this.maxAge) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }
  put(key: string, value: unknown): void {
    this.delete(key);
    let bytes: number;
    try {
      let visited = 0;
      let stringBytes = 0;
      bytes =
        JSON.stringify(value, (_key, item: unknown) => {
          if (++visited > 65_536) throw new Error('页面数据过大');
          const next = typeof item === 'bigint' ? item.toString() : item;
          if (typeof next === 'string') stringBytes += next.length * 2;
          if (stringBytes > this.maxBytes) throw new Error('页面数据过大');
          return next;
        }).length * 2;
    } catch {
      return;
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, savedAt: Date.now() });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  delete(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
}
