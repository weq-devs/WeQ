import type { UnreadInfoSnapshot } from '@weq/db';
import { classifyChatType } from '@weq/codec';
import { newerReadPosition } from '../common/client_preferences';
import { readJsonFile } from '../common/json_store';
import { writeFileAtomic } from '../common/atomic_write';

interface ManualReadState {
  latestSeq: string;
  unread: boolean;
  readSeq?: string;
  confirmed?: boolean;
  deviceRead?: string;
}
interface ReadPosition {
  sourceVersion: 2;
  readSeq?: string;
  deviceRead?: string;
  manual?: ManualReadState;
  operation?: number;
}
export interface ManualReadChange {
  previous?: ManualReadState;
  applied: ManualReadState;
  previousPosition: { readSeq?: string; deviceRead?: string };
  restoredPosition?: { readSeq?: string; deviceRead?: string };
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
export function validDeviceReadPosition(value: unknown): value is string {
  return typeof value === 'string' && /^0:[1-9]\d{0,9}:-?[1-9]\d{0,18}$/.test(value);
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
    loadPosition: (chatType: number) => boolean = () => true,
  ) {
    const raw = path ? readJsonFile(path) : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      const peer = /^(\d+)_.+/.exec(key);
      if (!peer || !loadPosition(Number(peer[1])) || !value || typeof value !== 'object') continue;
      const old = value as {
        sourceVersion?: number;
        localReadSeq?: string;
        readSeq?: string;
        operation?: number;
        deviceRead?: string;
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
              deviceRead: validDeviceReadPosition(manual.deviceRead)
                ? manual.deviceRead
                : undefined,
            }
          : undefined;
      const deviceRead = validDeviceReadPosition(old.deviceRead) ? old.deviceRead : undefined;
      if (!sequence(readSeq) && !migrated && !deviceRead) continue;
      this.positions.set(key, {
        sourceVersion: 2,
        readSeq: sequence(readSeq) ? readSeq : undefined,
        manual: migrated,
        operation: old.operation,
        deviceRead,
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

  markDeviceRead(snapshot: UnreadInfoSnapshot, position: string): boolean {
    const row = this.position(snapshot.chatType, snapshot.uid);
    const advances =
      newerReadPosition(position, row.deviceRead) &&
      newerReadPosition(position, snapshot.deviceRead);
    if (!advances && !row.manual && !snapshot.markUnread) return false;
    if (advances) row.deviceRead = position;
    if (snapshot.markUnread && row.manual?.unread !== false) {
      row.manual = { latestSeq: '0', unread: false, deviceRead: position };
    } else if (row.manual?.unread) {
      delete row.manual;
    } else if (!advances) {
      return false;
    }
    row.operation = ++this.revision;
    return true;
  }

  isDeviceReadCurrent(chatType: number, uid: string, position: string): boolean {
    const row = this.positions.get(`${chatType}_${uid}`);
    return !!row && !row.manual?.unread && row.deviceRead === position;
  }

  setManualRead(snapshot: ResolvedUnreadInfo, unread: boolean): ManualReadChange {
    const row = this.position(snapshot.chatType, snapshot.uid);
    const latest = snapshot.latestSeq ?? snapshot.readSeq ?? '0';
    const device =
      classifyChatType(snapshot.chatType) === 'dataline' &&
      Boolean(snapshot.deviceLatest || snapshot.deviceRead || row.deviceRead);
    const applied = {
      latestSeq: latest,
      unread,
      readSeq: unread ? snapshot.readSeq : latest,
      ...(device
        ? { deviceRead: unread ? (row.deviceRead ?? snapshot.deviceRead) : snapshot.deviceLatest }
        : {}),
    };
    const change: ManualReadChange = {
      previous: row.manual,
      applied,
      previousPosition: { readSeq: row.readSeq, deviceRead: row.deviceRead },
      previousOperation: row.operation,
      operation: ++this.revision,
    };
    if (
      !unread &&
      device &&
      snapshot.deviceLatest &&
      newerReadPosition(snapshot.deviceLatest, row.deviceRead) &&
      newerReadPosition(snapshot.deviceLatest, snapshot.deviceRead)
    )
      row.deviceRead = snapshot.deviceLatest;
    if (!unread && !device && BigInt(latest) > BigInt(row.readSeq ?? '0')) row.readSeq = latest;
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
    if (!reverse) change.restoredPosition = { readSeq: row.readSeq, deviceRead: row.deviceRead };
    row.readSeq = (reverse ? change.restoredPosition : change.previousPosition)?.readSeq;
    row.deviceRead = reverse
      ? change.restoredPosition?.deviceRead
      : change.previousPosition.deviceRead;
    row.manual = reverse ? change.applied : change.previous;
    row.operation = reverse ? change.operation : change.previousOperation;
    this.revision++;
    return true;
  }

  hasManualRead(chatType: number, uid: string, change: ManualReadChange): boolean {
    return this.positions.get(`${chatType}_${uid}`)?.operation === change.operation;
  }

  clear(): void {
    this.positions.clear();
    this.pendingOutgoing.clear();
    this.revision++;
  }

  resolve(snapshot: UnreadInfoSnapshot, confirmedSent: readonly string[] = []): ResolvedUnreadInfo {
    if (snapshot.readError) return snapshot;
    const row = this.positions.get(snapshot.peer);
    const device = classifyChatType(snapshot.chatType) === 'dataline';
    if (device && (snapshot.deviceRead || snapshot.deviceLatest || row?.deviceRead))
      return this.resolveDevice(snapshot, row);
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
    const recalled = snapshot.recalledSeqs;
    const highlights = snapshot.highlights?.filter(
      (hit) => BigInt(hit.msgSeq) > floor && !recalled?.includes(String(hit.msgSeq)),
    );
    const decreased = new Set(snapshot.decreasedSeqs);
    for (const seq of recalled ?? []) decreased.add(seq);
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
      for (const seq of confirmedSent) {
        // 小表若已确认同序号的对方正文，优先保留该条未读。
        if (
          seq !== snapshot.latestSeq ||
          !snapshot.latestSenderUid ||
          snapshot.latestSenderUid === this.selfUid
        )
          decreased.add(seq);
      }
    }
    if (snapshot.latestSeqNonMessage && snapshot.latestSeq !== null)
      decreased.add(snapshot.latestSeq);
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

  private resolveDevice(
    snapshot: UnreadInfoSnapshot,
    row: ReadPosition | undefined,
  ): ResolvedUnreadInfo {
    const qqRead = snapshot.deviceRead;
    if (qqRead && row?.deviceRead && !newerReadPosition(row.deviceRead, qqRead)) {
      delete row.deviceRead;
      this.revision++;
    }
    if (qqRead && row?.manual && newerReadPosition(qqRead, row.manual.deviceRead)) {
      delete row.manual;
      this.revision++;
    }
    const manuallyUnread = row?.manual?.unread ?? snapshot.markUnread;
    const floor = row?.deviceRead ?? qqRead;
    const hasUnread = snapshot.deviceLatest
      ? newerReadPosition(snapshot.deviceLatest, floor)
      : !row?.deviceRead &&
        ((snapshot.localUnreadCount ?? 0) > 0 || (snapshot.storedUnreadCount ?? 0) > 0);
    return { ...snapshot, unreadCount: hasUnread || manuallyUnread ? 1 : 0 };
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
