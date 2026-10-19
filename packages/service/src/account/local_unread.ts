import type { UnreadInfoSnapshot } from '@weq/db';
import { readJsonFile } from '../common/json_store';
import { writeFileAtomicSync } from '../common/atomic_write';

interface ReadPosition {
  latestSeq: string;
  baselineSeq?: string;
  readSeq?: string;
  pending: string[];
  manual?: ManualReadState;
}

interface ManualReadState {
  latestSeq: string;
  unreadCount: number;
  readSeq?: string;
  highlights?: UnreadInfoSnapshot['highlights'];
}

export interface ManualReadChange {
  previous?: ManualReadState;
  applied: ManualReadState;
}

export interface ResolvedUnreadInfo extends UnreadInfoSnapshot {
  unreadCount?: number;
  /** WeQ 的有效阅读位置；不替代原始 QQ msgSeq，也不用于协议上报。 */
  readSeq?: string;
}

function sequence(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}

/** 缺少 QQ 水位时只计明确的实时消息；历史快照只更新基线，不产生未读。 */
export class LocalUnreadStore {
  private readonly positions = new Map<string, ReadPosition>();
  private dirty = false;

  constructor(private readonly path?: string) {
    const raw = path ? readJsonFile(path) : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [key, value] of Object.entries(raw)) {
      if (!/^\d+_.+/.test(key) || !value || typeof value !== 'object') continue;
      const row = value as Partial<ReadPosition>;
      if (!sequence(row.latestSeq) || (row.readSeq !== undefined && !sequence(row.readSeq)))
        continue;
      if (row.baselineSeq !== undefined && !sequence(row.baselineSeq)) continue;
      if (!Array.isArray(row.pending) || !row.pending.every(sequence)) continue;
      this.positions.set(key, {
        latestSeq: row.latestSeq,
        baselineSeq: row.baselineSeq,
        readSeq: row.readSeq,
        pending: [...new Set(row.pending)].filter(
          (seq) => BigInt(seq) > BigInt(row.readSeq ?? '0'),
        ),
        manual:
          row.manual &&
          sequence(row.manual.latestSeq) &&
          Number.isSafeInteger(row.manual.unreadCount) &&
          row.manual.unreadCount >= 0 &&
          (row.manual.readSeq === undefined || sequence(row.manual.readSeq)) &&
          (row.manual.highlights === undefined ||
            (Array.isArray(row.manual.highlights) &&
              row.manual.highlights.every(
                (hit) =>
                  hit &&
                  Number.isSafeInteger(hit.msgSeq) &&
                  hit.msgSeq >= 0 &&
                  typeof hit.kind === 'string' &&
                  Number.isSafeInteger(hit.rawKind) &&
                  typeof hit.senderUid === 'string' &&
                  Number.isSafeInteger(hit.sendTime) &&
                  typeof hit.text === 'string',
              )))
            ? row.manual
            : undefined,
      });
    }
  }

  private position(chatType: number, uid: string, latestSeq = '0'): ReadPosition {
    const key = `${chatType}_${uid}`;
    let row = this.positions.get(key);
    if (!row) {
      row = { latestSeq, pending: [] };
      this.positions.set(key, row);
      this.dirty = true;
    }
    return row;
  }

  recordLive(chatType: number, uid: string, seq: string): void {
    if (!sequence(seq) || BigInt(seq) <= 0n) return;
    const row = this.position(chatType, uid);
    if (BigInt(seq) <= BigInt(row.readSeq ?? '0') || row.pending.includes(seq)) return;
    row.pending.push(seq);
    this.dirty = true;
  }

  markRead(chatType: number, uid: string, seq: string): boolean {
    if (!sequence(seq)) return false;
    const row = this.position(chatType, uid, seq);
    const cleared = row.manual !== undefined && BigInt(seq) >= BigInt(row.manual.latestSeq);
    if (cleared) {
      delete row.manual;
      this.dirty = true;
    }
    if (row.readSeq !== undefined && BigInt(row.readSeq) >= BigInt(seq)) return cleared;
    row.readSeq = seq;
    row.pending = row.pending.filter((pending) => BigInt(pending) > BigInt(seq));
    this.dirty = true;
    return true;
  }

  setManualRead(snapshot: ResolvedUnreadInfo, unread: boolean): ManualReadChange {
    const row = this.position(snapshot.chatType, snapshot.uid);
    const latest = [
      ...row.pending,
      ...(snapshot.highlights ?? []).map((hit) => String(hit.msgSeq)),
    ].reduce((max, seq) => (BigInt(seq) > BigInt(max) ? seq : max), snapshot.latestSeq ?? '0');
    const applied: ManualReadState = {
      latestSeq: latest,
      unreadCount: unread ? Math.max(1, snapshot.unreadCount ?? 0) : 0,
      readSeq:
        unread && (snapshot.unreadCount ?? 0) > 0
          ? snapshot.readSeq
          : unread && BigInt(latest) > 0n
            ? (BigInt(latest) - 1n).toString()
            : latest,
      highlights: unread ? snapshot.highlights : undefined,
    };
    const change = { previous: row.manual, applied };
    row.manual = applied;
    this.dirty = true;
    return change;
  }

  restoreManualRead(
    chatType: number,
    uid: string,
    change: ManualReadChange,
    reverse = false,
  ): boolean {
    const row = this.position(chatType, uid);
    if (row.manual !== (reverse ? change.previous : change.applied)) return false;
    row.manual = reverse ? change.applied : change.previous;
    this.dirty = true;
    return true;
  }

  resolve(snapshot: UnreadInfoSnapshot): ResolvedUnreadInfo {
    if (snapshot.readError) return snapshot;
    const latest = sequence(snapshot.latestSeq) ? snapshot.latestSeq : '0';
    const row = this.position(snapshot.chatType, snapshot.uid, latest);
    if (BigInt(latest) > BigInt(row.latestSeq)) {
      row.latestSeq = latest;
      this.dirty = true;
    }
    if (
      snapshot.msgSeq === undefined &&
      (row.baselineSeq === undefined || BigInt(latest) > BigInt(row.baselineSeq))
    ) {
      row.baselineSeq = latest;
      this.dirty = true;
    }
    // 保存可信 QQ 阅读进度，之后旧快照回流也不能让提醒复活。
    if (
      snapshot.msgSeq !== undefined &&
      (row.readSeq === undefined || BigInt(snapshot.msgSeq) > BigInt(row.readSeq))
    ) {
      row.readSeq = String(snapshot.msgSeq);
      row.pending = row.pending.filter((seq) => BigInt(seq) > BigInt(snapshot.msgSeq!));
      this.dirty = true;
    }
    const read = BigInt(row.readSeq ?? '0');
    const highlights = snapshot.highlights?.filter(
      (hit) => row.readSeq === undefined || BigInt(hit.msgSeq) > read,
    );
    const pending = new Set(row.pending);
    for (const hit of highlights ?? []) pending.add(String(hit.msgSeq));
    const first = [...pending].reduce<bigint | null>(
      (min, seq) => (min === null || BigInt(seq) < min ? BigInt(seq) : min),
      null,
    );
    const known = snapshot.msgSeq !== undefined;
    // 安静对齐不是已读，不能清掉实时消息或明确提醒；仅作为序号差的下限。
    const baseline = BigInt(row.baselineSeq ?? '0');
    const floor = read > baseline ? read : baseline;
    const firstRead = first !== null && first > 0n ? first - 1n : null;
    const resolved = {
      ...snapshot,
      highlights: highlights?.length ? highlights : undefined,
      unreadCount: known
        ? Math.max(Number(BigInt(latest) > floor ? BigInt(latest) - floor : 0n), pending.size)
        : pending.size,
      readSeq: known
        ? (firstRead !== null && firstRead < floor ? firstRead : floor).toString()
        : first !== null
          ? (first > 0n ? first - 1n : 0n).toString()
          : (row.readSeq ?? row.latestSeq),
    };
    if (!row.manual) return resolved;
    const manual = row.manual;
    const anchor = BigInt(manual.latestSeq);
    const newHighlights = snapshot.highlights?.filter((hit) => BigInt(hit.msgSeq) > anchor);
    const newer = new Set(row.pending.filter((seq) => BigInt(seq) > anchor));
    for (const hit of newHighlights ?? []) newer.add(String(hit.msgSeq));
    const newFloor = floor > anchor ? floor : anchor;
    const manualHighlights = [...(manual.highlights ?? []), ...(newHighlights ?? [])];
    return {
      ...resolved,
      unreadCount:
        manual.unreadCount +
        Math.max(
          known && BigInt(latest) > newFloor ? Number(BigInt(latest) - newFloor) : 0,
          newer.size,
        ),
      readSeq: manual.readSeq,
      highlights: manualHighlights.length ? manualHighlights : undefined,
    };
  }

  flush(): void {
    if (!this.dirty || !this.path) return;
    writeFileAtomicSync(this.path, JSON.stringify(Object.fromEntries(this.positions)));
    this.dirty = false;
  }
}
