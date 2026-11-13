import type { UnreadInfoSnapshot } from '@weq/db';
import { classifyChatType } from '@weq/codec';
import { readJsonFile } from '../common/json_store';
import { writeFileAtomic } from '../common/atomic_write';

interface ManualReadState {
  latestSeq: string;
  unread: boolean;
  readSeq?: string;
  confirmed?: boolean;
}
interface ReadPosition {
  sourceVersion: 2;
  readSeq?: string;
  manual?: ManualReadState;
  operation?: number;
}
export interface ManualReadChange {
  previous?: ManualReadState;
  applied: ManualReadState;
  previousPosition: { readSeq?: string };
  restoredPosition?: { readSeq?: string };
  operation: number;
  previousOperation?: number;
}
export interface ResolvedUnreadInfo extends UnreadInfoSnapshot {
  unreadCount?: number;
  readSeq?: string;
}
function sequence(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}
const pendingWrites = new Set<Promise<void>>();
export async function waitForUnreadWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
}

/** 只保存显式操作。QQ 小表直接提供计数基准，不再落盘消息集合或观察水位。 */
export class LocalUnreadStore {
  private readonly positions = new Map<string, ReadPosition>();
  private readonly pendingOutgoing = new Map<string, Set<string>>();
  private revision = 0;
  private savedRevision = 0;
  private writing?: Promise<void>;

  constructor(
    private readonly path?: string,
    private readonly selfUid?: string,
  ) {
    const raw = path ? readJsonFile(path) : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      if (!/^\d+_.+/.test(key) || !value || typeof value !== 'object') continue;
      const old = value as {
        sourceVersion?: number;
        localReadSeq?: string;
        readSeq?: string;
        operation?: number;
        manual?: ManualReadState & { unreadCount?: number };
      };
      const readSeq =
        old.sourceVersion === 2
          ? old.readSeq
          : old.sourceVersion === 1
            ? old.localReadSeq
            : old.readSeq;
      const manual = old.manual;
      const migrated =
        manual &&
        sequence(manual.latestSeq) &&
        (typeof manual.unread === 'boolean' || Number.isSafeInteger(manual.unreadCount))
          ? {
              latestSeq: manual.latestSeq,
              unread: manual.unread ?? (manual.unreadCount ?? 0) > 0,
              readSeq: sequence(manual.readSeq) ? manual.readSeq : undefined,
              confirmed: manual.confirmed,
            }
          : undefined;
      if (!sequence(readSeq) && !migrated) continue;
      this.positions.set(key, {
        sourceVersion: 2,
        readSeq: sequence(readSeq) ? readSeq : undefined,
        manual: migrated,
        operation: old.operation,
      });
    }
  }

  private position(chatType: number, uid: string): ReadPosition {
    const key = `${chatType}_${uid}`;
    let row = this.positions.get(key);
    if (!row) {
      row = { sourceVersion: 2 };
      this.positions.set(key, row);
    }
    return row;
  }

  markRead(chatType: number, uid: string, seq: string): boolean {
    if (!sequence(seq)) return false;
    const row = this.position(chatType, uid);
    const changed = BigInt(seq) > BigInt(row.readSeq ?? '0') || row.manual !== undefined;
    if (!changed) return false;
    if (BigInt(seq) > BigInt(row.readSeq ?? '0')) row.readSeq = seq;
    delete row.manual;
    row.operation = ++this.revision;
    return true;
  }

  setManualRead(snapshot: ResolvedUnreadInfo, unread: boolean): ManualReadChange {
    const row = this.position(snapshot.chatType, snapshot.uid);
    const latest = snapshot.latestSeq ?? snapshot.readSeq ?? '0';
    const applied = { latestSeq: latest, unread, readSeq: unread ? snapshot.readSeq : latest };
    const change: ManualReadChange = {
      previous: row.manual,
      applied,
      previousPosition: { readSeq: row.readSeq },
      previousOperation: row.operation,
      operation: ++this.revision,
    };
    if (!unread && BigInt(latest) > BigInt(row.readSeq ?? '0')) row.readSeq = latest;
    row.manual = applied;
    row.operation = change.operation;
    return change;
  }

  restoreManualRead(
    chatType: number,
    uid: string,
    change: ManualReadChange,
    reverse = false,
  ): boolean {
    const row = this.position(chatType, uid);
    if (row.operation !== (reverse ? change.previousOperation : change.operation)) return false;
    if (!reverse) change.restoredPosition = { readSeq: row.readSeq };
    row.readSeq = (reverse ? change.restoredPosition : change.previousPosition)?.readSeq;
    row.manual = reverse ? change.applied : change.previous;
    row.operation = reverse ? change.operation : change.previousOperation;
    this.revision++;
    return true;
  }

  hasManualRead(chatType: number, uid: string, change: ManualReadChange): boolean {
    return this.positions.get(`${chatType}_${uid}`)?.operation === change.operation;
  }

  resolve(snapshot: UnreadInfoSnapshot): ResolvedUnreadInfo {
    if (snapshot.readError) return snapshot;
    const row = this.positions.get(snapshot.peer);
    const databaseRead = [String(snapshot.msgSeq ?? 0), snapshot.localReadSeq ?? '0'].reduce(
      (a, b) => (BigInt(a) > BigInt(b) ? a : b),
    );
    if (row?.readSeq && BigInt(databaseRead) > BigInt(row.readSeq)) {
      delete row.readSeq;
      this.revision++;
    }
    const manual = row?.manual;
    if (
      manual &&
      !manual.unread &&
      BigInt(databaseRead) >= BigInt(manual.latestSeq) &&
      snapshot.markUnread !== true
    ) {
      delete row!.manual;
      this.revision++;
    }
    if (manual?.unread && snapshot.markUnread === true && !manual.confirmed) {
      manual.confirmed = true;
      this.revision++;
    } else if (
      manual?.unread &&
      ((manual.confirmed && snapshot.markUnread === false) ||
        BigInt(databaseRead) > BigInt(manual.readSeq ?? '0'))
    ) {
      delete row!.manual;
      this.revision++;
    }
    const read = BigInt(row?.readSeq ?? '0') > BigInt(databaseRead) ? row!.readSeq! : databaseRead;
    const floor = BigInt(read);
    const latest = snapshot.latestSeq === null ? null : BigInt(snapshot.latestSeq);
    const highlights = snapshot.highlights?.filter((hit) => BigInt(hit.msgSeq) > floor);
    const device = classifyChatType(snapshot.chatType) === 'dataline';
    const decreased = new Set(snapshot.decreasedSeqs ?? []);
    // QQ 可能先更新最新消息，再补减项。仅暂存小表已确认的自发序号，不抬高阅读水位。
    if (!device) {
      const outgoing = this.pendingOutgoing.get(snapshot.peer) ?? new Set<string>();
      for (const seq of outgoing)
        if (BigInt(seq) <= floor || decreased.has(seq)) outgoing.delete(seq);
      if (
        this.selfUid &&
        snapshot.latestSenderUid === this.selfUid &&
        latest !== null &&
        latest > floor &&
        !decreased.has(snapshot.latestSeq!)
      )
        outgoing.add(snapshot.latestSeq!);
      // 短暂补偿有界且不落盘；QQ 小表接纳后即释放。
      while (outgoing.size > 64) outgoing.delete(outgoing.values().next().value!);
      if (outgoing.size) {
        this.pendingOutgoing.set(snapshot.peer, outgoing);
        while (this.pendingOutgoing.size > 1024)
          this.pendingOutgoing.delete(this.pendingOutgoing.keys().next().value!);
        for (const seq of outgoing) decreased.add(seq);
      } else this.pendingOutgoing.delete(snapshot.peer);
    }
    const deductions = [...decreased].filter(
      (seq) => BigInt(seq) > floor && latest !== null && BigInt(seq) <= latest,
    ).length;
    const hasRead =
      snapshot.msgSeq !== undefined ||
      snapshot.localReadSeq !== undefined ||
      row?.readSeq !== undefined;
    let count = device
      ? snapshot.chatType === 8
        ? (snapshot.localUnreadCount ?? snapshot.storedUnreadCount ?? 0)
        : (snapshot.storedUnreadCount ?? snapshot.localUnreadCount ?? 0)
      : latest !== null && hasRead && floor > 0n
        ? Math.max(0, Number(latest - floor) - deductions)
        : 0;
    if (device && row?.readSeq && latest !== null && floor >= latest) count = 0;
    const marked = row?.manual ? row.manual.unread : snapshot.markUnread;
    if (marked || highlights?.length) count = Math.max(1, count);
    return {
      ...snapshot,
      unreadCount: count,
      readSeq: hasRead ? read : undefined,
      highlights: highlights?.length ? highlights : undefined,
    };
  }

  async flush(): Promise<void> {
    if (!this.path) return;
    const requested = this.revision;
    while (this.savedRevision < requested) {
      if (!this.writing) {
        const write = Promise.resolve()
          .then(async () => {
            const version = this.revision;
            await writeFileAtomic(this.path!, JSON.stringify(Object.fromEntries(this.positions)));
            this.savedRevision = version;
          })
          .finally(() => {
            this.writing = undefined;
            pendingWrites.delete(write);
          });
        this.writing = write;
        pendingWrites.add(write);
      }
      await this.writing;
    }
  }
}
