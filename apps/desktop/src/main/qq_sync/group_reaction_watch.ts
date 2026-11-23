import type { AccountSession } from '@weq/account';
import { withDatabasePriority } from '@weq/db';

type Reader = AccountSession['groupMsgs']['listReactionStates'];
export type GroupReactionStates = Awaited<ReturnType<Reader>>;
type Subscriber = (rows: GroupReactionStates) => void;

interface GroupWatch {
  listeners: Set<Subscriber>;
  pending: Set<bigint>;
  timer?: ReturnType<typeof setTimeout>;
  active?: AbortController;
}

/** 查询只随有订阅的群发生，同一宿主的多个客户端共用结果。 */
export class GroupReactionWatch {
  private readonly groups = new Map<string, GroupWatch>();

  constructor(
    private readonly read: Reader,
    private readonly isCurrent: () => boolean,
  ) {}

  subscribe(group: string, listener: Subscriber): () => void {
    let entry = this.groups.get(group);
    if (!entry) {
      entry = { listeners: new Set(), pending: new Set() };
      this.groups.set(group, entry);
    }
    const watch = entry;
    watch.listeners.add(listener);
    return () => {
      watch.listeners.delete(listener);
      if (watch.listeners.size || this.groups.get(group) !== watch) return;
      this.reset(watch);
      this.groups.delete(group);
    };
  }

  observe(group: string, sequence: number): void {
    const watch = this.groups.get(group);
    if (!watch || !this.isCurrent()) return;
    if (watch.pending.size >= 128) return; // 库文件仍会补齐未纳入此批的消息。
    watch.pending.add(BigInt(sequence));
    this.schedule(group, watch);
  }

  clearPending(): void {
    for (const watch of this.groups.values()) this.reset(watch);
  }

  private reset(watch: GroupWatch): void {
    clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.pending.clear();
    watch.active?.abort();
    watch.active = undefined;
  }

  private schedule(group: string, watch: GroupWatch): void {
    if (watch.timer || watch.active || !watch.pending.size) return;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.flush(group, watch);
    }, 250).unref();
  }

  private async flush(group: string, watch: GroupWatch): Promise<void> {
    if (this.groups.get(group) !== watch || !this.isCurrent()) return;
    const seqs = [...watch.pending];
    watch.pending.clear();
    const active = new AbortController();
    watch.active = active;
    try {
      const rows = await withDatabasePriority(
        'interactive',
        () => this.read(group, seqs),
        active.signal,
      );
      if (!active.signal.aborted && this.isCurrent() && rows.length)
        for (const listener of watch.listeners) listener(rows);
    } catch {
      // 后续数据库文件变化仍校准消息。
    } finally {
      if (watch.active === active) {
        watch.active = undefined;
        this.schedule(group, watch);
      }
    }
  }
}
