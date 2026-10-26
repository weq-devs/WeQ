export interface EntryWindow<T> {
  rows: T[];
  anchored: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}

/** 先交付阅读位置之前的上下文，再读取其后的单页；两阶段之间不等待尾页。 */
export async function loadConversationEntry<T extends { msgSeq: string }>({
  cached,
  dirty,
  readSeq,
  readFromFirstUnread = false,
  limit,
  before,
  after,
  latest,
  current,
  show,
  cursor = (rows) => rows.at(-1)?.msgSeq,
  resolveReadSeq,
  active = current,
  settled,
}: {
  cached?: EntryWindow<T>;
  dirty: boolean;
  readSeq?: string;
  readFromFirstUnread?: boolean;
  limit: number;
  before: (seq: string, limit: number) => Promise<T[]>;
  after: (seq: string, limit: number) => Promise<T[]>;
  latest: (limit: number) => Promise<T[]>;
  current: () => boolean;
  show: (window: EntryWindow<T>, first: boolean) => void;
  cursor?: (rows: T[]) => string | undefined;
  resolveReadSeq?: () => Promise<string | undefined>;
  /** 窗口已改变时可拒收结果，但仍由原会话负责结束加载；切号／切会话后则不收尾。 */
  active?: () => boolean;
  settled?: () => void;
}): Promise<void> {
  try {
    if (!current()) return;
    if (!readFromFirstUnread) {
      // 普通模式只恢复尾部缓存，历史窗口不冒充最新页。
      if (cached?.anchored && cached.rows.length) show(cached, true);
      else cached = undefined;
      const rows = await latest(limit);
      if (current())
        show(
          { rows: rows.reverse(), anchored: true, hasOlder: rows.length >= limit, hasNewer: false },
          !cached,
        );
      return;
    }
    if (cached?.rows.length === 0) cached = undefined;
    if (readFromFirstUnread && !cached && !readSeq && resolveReadSeq) {
      readSeq = await resolveReadSeq();
      if (!current()) return;
    }
    let window = cached;
    if (!window) {
      if (readSeq && /^\d+$/.test(readSeq)) {
        const rows = await before(String(BigInt(readSeq) + 1n), limit);
        if (!current()) return;
        window = {
          rows: rows.reverse(),
          anchored: false,
          hasOlder: rows.length >= limit,
          hasNewer: true,
        };
        show(window, true);
      } else {
        const rows = await latest(limit);
        if (current())
          show(
            {
              rows: rows.reverse(),
              anchored: true,
              hasOlder: rows.length >= limit,
              hasNewer: false,
            },
            true,
          );
        return;
      }
    } else if (dirty && /^[1-9]\d*$/.test(cursor(window.rows) ?? '')) {
      const size = Math.min(200, Math.max(limit, window.rows.length));
      const rows = await before(String(BigInt(cursor(window.rows)!) + 1n), size);
      if (!current()) return;
      window = {
        ...window,
        rows: rows.reverse(),
        hasOlder: window.hasOlder || rows.length >= size,
      };
      show(window, false);
    }
    if (!current() || (!window.anchored && !window.hasNewer)) return;
    // 历史窗口保留原边界，后续分页由用户向下阅读触发。
    if (cached && !cached.anchored) return;
    const tail = cursor(window.rows) ?? readSeq;
    if (!tail || !/^\d+$/.test(tail)) return;
    const rows = await after(tail, limit);
    if (!current()) return;
    show(
      {
        ...window,
        rows: [...window.rows, ...rows],
        anchored: rows.length < limit,
        hasNewer: rows.length >= limit,
      },
      false,
    );
  } finally {
    if (active()) settled?.();
  }
}
