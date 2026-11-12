import type { UnreadInfoSnapshot, UnreadInfoTarget } from '@weq/db';
import type { NtHelperBinding, QqUnreadSnapshot } from '@weq/native';

export const VERIFIED_QQ_UNREAD_LAYOUT = 'qqnt-macos-arm64-7.0.3-54395';
export const QQ_UNREAD_COVERAGE = 'instantiated-direct-and-group';
const REFRESH_MS = 1500;

/** 来源负责身份校验；没有同批阅读边界的计数不得推算 QQ 阅读位置。 */
export interface UnreadCountSource {
  identity(): string | null;
  read(): Promise<QqUnreadSnapshot>;
  clear(): void;
}

export function createQqUnreadCountSource(
  nt: Pick<NtHelperBinding, 'getQqUnreadCapability' | 'readQqUnreadCounts' | 'clearQqUnreadCache'>,
  databasePath: string,
  resolvePid: () => number | null,
): UnreadCountSource | undefined {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  if (!nt.getQqUnreadCapability || !nt.readQqUnreadCounts || !nt.clearQqUnreadCache)
    return undefined;
  try {
    const capability = nt.getQqUnreadCapability();
    if (
      !capability.supported ||
      !capability.readOnly ||
      capability.coverage !== QQ_UNREAD_COVERAGE ||
      !capability.layouts.includes(VERIFIED_QQ_UNREAD_LAYOUT)
    )
      return undefined;
  } catch {
    return undefined;
  }
  let ownedPid: number | null = null;
  return {
    identity: () => {
      const pid = resolvePid();
      return pid === null ? null : `${pid}:${databasePath}`;
    },
    async read() {
      const pid = resolvePid();
      if (ownedPid !== null && ownedPid !== pid) nt.clearQqUnreadCache!(ownedPid);
      ownedPid = pid;
      if (pid === null) throw new Error('QQ 未读来源不可用');
      return nt.readQqUnreadCounts!({ pid, databasePath, timeoutMs: 60000 });
    },
    clear() {
      if (ownedPid !== null) nt.clearQqUnreadCache!(ownedPid);
      ownedPid = null;
    },
  };
}

function boundary(row: UnreadInfoSnapshot): string | null {
  if (row.readError || row.latestSeq === null || !/^\d{1,20}$/.test(row.latestSeq)) return null;
  return JSON.stringify([
    row.latestSeq,
    row.msgSeq,
    row.highlights?.length ? row.highlights : null,
  ]);
}

interface CountEntry extends UnreadInfoTarget {
  count: number;
  boundary: string;
}

/** 冷定位永不进入请求等待链；定位完成后重新夹取 DB 水位，不使用启动数字差。 */
export class UnreadCountCache {
  private entries = new Map<string, CountEntry>();
  private readonly observed = new Set<string>();
  private identity: string | null = null;
  private generation?: string;
  private updatedAt = 0;
  private running = false;
  private disposed = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly source: UnreadCountSource,
    private readonly watermarks: (targets: UnreadInfoTarget[]) => Promise<UnreadInfoSnapshot[]>,
    private readonly changed: (targets: UnreadInfoTarget[]) => void,
  ) {}

  start(): void {
    if (!this.disposed && !this.running && !this.timer) void this.refresh();
  }

  get(row: UnreadInfoSnapshot): number | undefined {
    if (
      this.disposed ||
      this.currentIdentity() !== this.identity ||
      Date.now() - this.updatedAt > REFRESH_MS * 3
    )
      return undefined;
    const entry = this.entries.get(row.peer);
    return entry?.boundary === boundary(row) ? entry.count : undefined;
  }

  get ready(): boolean {
    return this.entries.size > 0 && this.currentIdentity() === this.identity;
  }

  /** 失去曾使用的计数来源不等于已读；没有本地差异时等待该来源重新确认。 */
  requiresConfirmation(row: UnreadInfoSnapshot): boolean {
    const identity = this.currentIdentity();
    return this.observed.has(row.peer) && (identity === null || identity === this.identity);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.entries.clear();
    this.observed.clear();
    try {
      this.source.clear();
    } catch {
      // 本地结果已停用；原生清理失败也不能阻断账号其余关闭流程。
    }
  }

  private currentIdentity(): string | null {
    try {
      return this.source.identity();
    } catch {
      return null;
    }
  }

  private valid(snapshot: QqUnreadSnapshot): boolean {
    return (
      snapshot.success &&
      snapshot.coverage === QQ_UNREAD_COVERAGE &&
      snapshot.layout === VERIFIED_QQ_UNREAD_LAYOUT &&
      Boolean(snapshot.generation) &&
      snapshot.rows.length <= 8192 &&
      snapshot.rows.every(
        (row) =>
          (row.chatType === 1 || row.chatType === 2) &&
          Boolean(row.uid) &&
          Number.isSafeInteger(row.unreadCount) &&
          row.unreadCount >= 0,
      ) &&
      new Set(snapshot.rows.map((row) => `${row.chatType}_${row.uid}`)).size ===
        snapshot.rows.length
    );
  }

  private async refresh(): Promise<void> {
    this.running = true;
    const identity = this.currentIdentity();
    const current = () =>
      !this.disposed && identity !== null && this.currentIdentity() === identity;
    const previous = this.entries;
    try {
      if (!current()) throw new Error('QQ 未读来源已变化');
      const located = await this.source.read();
      if (!current()) return;
      if (!this.valid(located)) throw new Error('QQ 未读计数不可用');
      // 第一次可能经历十几秒定位。只能用定位后的 DB 与下一次短读对齐。
      const before = await this.watermarks(located.rows);
      if (!current()) return;
      const counts = await this.source.read();
      if (!current()) return;
      if (!this.valid(counts) || counts.generation !== located.generation)
        throw new Error('QQ 未读来源代已变化');
      const after = await this.watermarks(located.rows);
      if (!current()) return;
      const beforeByPeer = new Map(before.map((row) => [row.peer, boundary(row)]));
      const afterByPeer = new Map(after.map((row) => [row.peer, boundary(row)]));
      const missing = new Set(counts.missingTargets.map((row) => `${row.chatType}_${row.uid}`));
      const next = new Map<string, CountEntry>();
      for (const row of counts.rows) {
        const key = `${row.chatType}_${row.uid}`;
        const aligned = afterByPeer.get(key);
        if (!missing.has(key) && aligned && aligned === beforeByPeer.get(key))
          next.set(key, { ...row, count: row.unreadCount, boundary: aligned });
      }
      this.entries = next;
      if (this.identity !== identity) this.observed.clear();
      for (const key of next.keys()) {
        if (!this.observed.has(key) && this.observed.size >= 8192)
          this.observed.delete(this.observed.values().next().value!);
        this.observed.add(key);
      }
      this.identity = identity;
      const generationChanged = this.generation !== counts.generation;
      this.generation = counts.generation;
      this.updatedAt = Date.now();
      this.failures = 0;
      const changed = new Map<string, UnreadInfoTarget>();
      for (const [key, row] of [...previous, ...next]) {
        const old = previous.get(key),
          value = next.get(key);
        if (generationChanged || old?.count !== value?.count || old?.boundary !== value?.boundary)
          changed.set(key, row);
      }
      if (changed.size) this.changed([...changed.values()]);
    } catch {
      if (!this.disposed) {
        this.entries = new Map();
        this.failures = Math.min(5, this.failures + 1);
        if (previous.size) this.changed([...previous.values()]);
      }
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.start();
          },
          Math.min(30000, REFRESH_MS * 2 ** this.failures),
        );
        this.timer.unref?.();
      }
    }
  }
}
