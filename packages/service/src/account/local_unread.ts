import type { UnreadInfoSnapshot } from '@weq/db';
import { readJsonFile } from '../common/json_store';
import { writeFileAtomic } from '../common/atomic_write';
import { classifyChatType } from '@weq/codec';

interface ReadPosition {
  latestSeq: string;
  /** 版本缺失的旧记录保守视为含有 WeQ 阅读，不能凭写库后的水位消除。 */
  sourceVersion?: 1;
  localReadSeq?: string;
  operation?: number;
  baselineSeq?: string;
  readSeq?: string;
  pending: string[];
  manual?: ManualReadState;
}

interface ManualReadState {
  latestSeq: string;
  unread: boolean;
  readSeq?: string;
}

export interface ManualReadChange {
  previous?: ManualReadState;
  applied: ManualReadState;
  previousPosition: Pick<ReadPosition, 'readSeq' | 'localReadSeq' | 'baselineSeq' | 'pending'>;
  restoredPosition?: Pick<ReadPosition, 'readSeq' | 'localReadSeq' | 'baselineSeq' | 'pending'>;
  operation: number;
  previousOperation?: number;
}

export interface ResolvedUnreadInfo extends UnreadInfoSnapshot {
  /** 基础水位已返回，仍需精确排除自己发送；调用方不得据此清零。 */
  countPending?: true;
  unreadCount?: number;
  /** WeQ 的有效阅读位置；不替代原始 QQ msgSeq，也不用于协议上报。 */
  readSeq?: string;
}

function sequence(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}

const pendingWrites = new Set<Promise<void>>();
/** 新账号读取本地状态前，等待旧账号已开始的发布完成。 */
export async function waitForUnreadWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
}

/** 缺少 QQ 水位时只计明确的实时消息；历史快照只更新基线，不产生未读。 */
export class LocalUnreadStore {
  private readonly positions = new Map<string, ReadPosition>();
  private revision = 0;
  private savedRevision = 0;
  private writing?: Promise<void>;

  constructor(private readonly path?: string) {
    const raw = path ? readJsonFile(path) : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      if (!/^\d+_.+/.test(key) || !value || typeof value !== 'object') continue;
      const row = value as Partial<ReadPosition>;
      if (!sequence(row.latestSeq) || (row.readSeq !== undefined && !sequence(row.readSeq)))
        continue;
      if (row.baselineSeq !== undefined && !sequence(row.baselineSeq)) continue;
      if (row.localReadSeq !== undefined && !sequence(row.localReadSeq)) continue;
      if (!Array.isArray(row.pending) || !row.pending.every(sequence)) continue;
      const manual = row.manual as
        | (Partial<ManualReadState> & { unreadCount?: number })
        | undefined;
      this.positions.set(key, {
        latestSeq: row.latestSeq,
        sourceVersion: 1,
        localReadSeq: row.sourceVersion === 1 ? row.localReadSeq : row.readSeq,
        baselineSeq: row.baselineSeq,
        readSeq: row.readSeq,
        pending: [...new Set(row.pending)].filter(
          (seq) => BigInt(seq) > BigInt(row.readSeq ?? '0'),
        ),
        manual:
          manual &&
          sequence(manual.latestSeq) &&
          (typeof manual.unread === 'boolean' ||
            (Number.isSafeInteger(manual.unreadCount) && manual.unreadCount! >= 0)) &&
          (manual.readSeq === undefined || sequence(manual.readSeq))
            ? {
                latestSeq: manual.latestSeq,
                unread: manual.unread ?? manual.unreadCount! > 0,
                readSeq: manual.readSeq,
              }
            : undefined,
      });
    }
  }

  private position(chatType: number, uid: string, latestSeq = '0'): ReadPosition {
    const key = `${chatType}_${uid}`;
    let row = this.positions.get(key);
    if (!row) {
      row = { latestSeq, sourceVersion: 1, pending: [] };
      this.positions.set(key, row);
      this.revision++;
    }
    return row;
  }

  recordLive(chatType: number, uid: string, seq: string): void {
    if (!sequence(seq) || BigInt(seq) <= 0n) return;
    const row = this.position(chatType, uid);
    if (BigInt(seq) <= BigInt(row.readSeq ?? '0') || row.pending.includes(seq)) return;
    row.pending.push(seq);
    this.revision++;
  }

  markRead(chatType: number, uid: string, seq: string): boolean {
    if (!sequence(seq)) return false;
    const row = this.position(chatType, uid, seq);
    const localChanged = row.localReadSeq === undefined || BigInt(seq) > BigInt(row.localReadSeq);
    if (localChanged) {
      row.localReadSeq = seq;
    }
    if (localChanged || row.manual) row.operation = ++this.revision;
    const cleared = row.manual !== undefined && BigInt(seq) >= BigInt(row.manual.latestSeq);
    if (cleared) {
      delete row.manual;
      this.revision++;
    }
    if (row.readSeq !== undefined && BigInt(row.readSeq) >= BigInt(seq))
      return cleared || localChanged;
    row.readSeq = seq;
    row.pending = row.pending.filter((pending) => BigInt(pending) > BigInt(seq));
    this.revision++;
    return true;
  }

  setManualRead(snapshot: ResolvedUnreadInfo, unread: boolean): ManualReadChange {
    const row = this.position(snapshot.chatType, snapshot.uid);
    const latest = [
      ...(snapshot.latestSeq === null ? row.pending : []),
      ...(snapshot.highlights ?? []).map((hit) => String(hit.msgSeq)),
    ].reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max), snapshot.latestSeq ?? '0');
    const applied: ManualReadState = {
      latestSeq: latest,
      unread,
      readSeq:
        unread && (snapshot.unreadCount ?? 0) > 0
          ? snapshot.readSeq
          : unread && BigInt(latest) > 0n
            ? (BigInt(latest) - 1n).toString()
            : latest,
    };
    const change = {
      previous: row.manual,
      applied,
      previousPosition: {
        readSeq: row.readSeq,
        localReadSeq: row.localReadSeq,
        baselineSeq: row.baselineSeq,
        pending: [...row.pending],
      },
      previousOperation: row.operation,
      operation: ++this.revision,
    };
    // 再标未读不撤销先前阅读；只撤销对应操作时才恢复阅读范围。
    const through = unread
      ? row.manual?.unread === false
        ? row.manual.latestSeq
        : undefined
      : latest;
    if (through !== undefined) {
      if (row.localReadSeq === undefined || BigInt(through) > BigInt(row.localReadSeq))
        row.localReadSeq = through;
      if (row.readSeq === undefined || BigInt(through) > BigInt(row.readSeq)) row.readSeq = through;
      row.pending = row.pending.filter((seq) => BigInt(seq) > BigInt(through));
    }
    row.manual = applied;
    row.operation = change.operation;
    this.revision++;
    return change;
  }

  restoreManualRead(
    chatType: number,
    uid: string,
    change: ManualReadChange,
    reverse = false,
  ): boolean {
    const row = this.position(chatType, uid);
    if (
      row.manual !== (reverse ? change.previous : change.applied) ||
      (!reverse && row.operation !== change.operation)
    )
      return false;
    if (!reverse)
      change.restoredPosition = {
        readSeq: row.readSeq,
        localReadSeq: row.localReadSeq,
        baselineSeq: row.baselineSeq,
        pending: [...row.pending],
      };
    const position = reverse ? change.restoredPosition : change.previousPosition;
    if (position) {
      const newer = row.pending.filter((seq) => BigInt(seq) > BigInt(change.applied.latestSeq));
      row.readSeq = position.readSeq;
      row.localReadSeq = position.localReadSeq;
      row.baselineSeq = position.baselineSeq;
      row.pending = [...new Set([...position.pending, ...newer])];
    }
    row.manual = reverse ? change.applied : change.previous;
    row.operation = reverse ? change.operation : change.previousOperation;
    this.revision++;
    return true;
  }

  hasManualRead(chatType: number, uid: string, change: ManualReadChange): boolean {
    const row = this.position(chatType, uid);
    return row.manual === change.applied && row.operation === change.operation;
  }

  /** 统计只需排除有效阅读位置之后的自己发言；不替换 QQ 的原始水位。 */
  countFloor(chatType: number, uid: string): string | undefined {
    const row = this.positions.get(`${chatType}_${uid}`);
    if (!row) return undefined;
    const values = [
      row.readSeq,
      row.baselineSeq,
      row.manual && !row.manual.unread ? row.manual.latestSeq : undefined,
    ].filter(sequence);
    return values.reduce<string | undefined>(
      (max, value) => (max === undefined || BigInt(value) > BigInt(max) ? value : max),
      undefined,
    );
  }

  /** 计数型来源没有阅读边界，存在本地阅读时必须精确回退，不能猜固定差值。 */
  canUseCount(snapshot: UnreadInfoSnapshot): boolean {
    if (snapshot.readError || !sequence(snapshot.latestSeq)) return false;
    const row = this.positions.get(snapshot.peer);
    return (
      !row?.localReadSeq &&
      row?.manual?.unread !== false &&
      !(row?.pending ?? []).some((seq) => BigInt(seq) > BigInt(snapshot.latestSeq ?? '0'))
    );
  }

  resolve(snapshot: UnreadInfoSnapshot, qqCount?: number): ResolvedUnreadInfo {
    if (snapshot.readError) return snapshot;
    const latest = sequence(snapshot.latestSeq) ? snapshot.latestSeq : '0';
    const row = this.position(snapshot.chatType, snapshot.uid, latest);
    if (BigInt(latest) > BigInt(row.latestSeq)) {
      row.latestSeq = latest;
      this.revision++;
    }
    if (
      snapshot.msgSeq === undefined &&
      (row.baselineSeq === undefined || BigInt(latest) > BigInt(row.baselineSeq))
    ) {
      row.baselineSeq = latest;
      this.revision++;
    }
    // 保存可信 QQ 阅读进度，之后旧快照回流也不能让提醒复活。
    if (
      snapshot.msgSeq !== undefined &&
      (row.readSeq === undefined || BigInt(snapshot.msgSeq) > BigInt(row.readSeq))
    ) {
      row.readSeq = String(snapshot.msgSeq);
      row.pending = row.pending.filter((seq) => BigInt(seq) > BigInt(snapshot.msgSeq!));
      this.revision++;
    }
    const read = BigInt(
      row.manual && !row.manual.unread && BigInt(row.manual.latestSeq) > BigInt(row.readSeq ?? '0')
        ? row.manual.latestSeq
        : (row.readSeq ?? '0'),
    );
    const highlights = snapshot.highlights?.filter((hit) => BigInt(hit.msgSeq) > read);
    const pending = new Set(row.pending.filter((seq) => BigInt(seq) > read));
    for (const hit of highlights ?? []) pending.add(String(hit.msgSeq));
    const first = [...pending].reduce<bigint | null>(
      (min, seq) => (min === null || BigInt(seq) < min ? BigInt(seq) : min),
      null,
    );
    const known = snapshot.msgSeq !== undefined;
    const countSequenceGap = known && classifyChatType(snapshot.chatType) !== 'dataline';
    // 安静对齐不是已读，不能清掉实时消息或明确提醒；仅作为序号差的下限。
    const baseline = BigInt(row.baselineSeq ?? '0');
    const floor = read > baseline ? read : baseline;
    const outgoing = new Set(snapshot.outgoingSeqs ?? []);
    const sequenceGap = (after: bigint) => {
      const end = BigInt(latest);
      if (!countSequenceGap || end <= after) return 0;
      const sent = [...outgoing].filter((seq) => BigInt(seq) > after && BigInt(seq) <= end);
      return Math.max(0, Number(end - after) - sent.length);
    };
    const firstRead = first !== null && first > 0n ? first - 1n : null;
    const resolved: ResolvedUnreadInfo = {
      ...snapshot,
      highlights: highlights?.length ? highlights : undefined,
      unreadCount: countSequenceGap ? Math.max(sequenceGap(floor), pending.size) : pending.size,
      readSeq: known
        ? (firstRead !== null && firstRead < floor ? firstRead : floor).toString()
        : first !== null
          ? (first > 0n ? first - 1n : 0n).toString()
          : (row.readSeq ?? row.latestSeq),
    };
    if (
      qqCount !== undefined &&
      Number.isSafeInteger(qqCount) &&
      qqCount >= 0 &&
      this.canUseCount(snapshot)
    ) {
      // 没有消息边界时不伪造跳转位置；相同数量也不是 QQ 确认本地阅读的证据。
      if (qqCount !== resolved.unreadCount) resolved.readSeq = undefined;
      resolved.unreadCount = qqCount;
    }
    if (row.manual?.unread && resolved.unreadCount === 0)
      return { ...resolved, unreadCount: 1, readSeq: row.manual.readSeq };
    return resolved;
  }

  async flush(): Promise<void> {
    if (!this.path) return;
    const requested = this.revision;
    while (this.savedRevision < requested) {
      if (!this.writing) {
        const path = this.path;
        const write = Promise.resolve()
          .then(async () => {
            const version = this.revision;
            const data = JSON.stringify(Object.fromEntries(this.positions));
            await writeFileAtomic(path, data);
            this.savedRevision = version;
          })
          .finally(() => {
            this.writing = undefined;
            pendingWrites.delete(write);
          });
        this.writing = write;
        pendingWrites.add(write);
      }
      // 自己的版本发布才确认；失败保留未保存版本，后续调用仍可重试。
      await this.writing;
    }
  }
}
