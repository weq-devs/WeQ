import type { Message } from '../im-template/template/types';
import { forwardResIdOf } from '../components/mergeForward/model';

export interface LocalOutgoingRecord {
  id: string;
  convId: string;
  state: 'sending' | 'sent' | 'failed';
  seq?: string;
  afterSeq?: string;
  cid?: string;
  seqRejected?: boolean;
  fileSync?: { fileId: string };
}

interface ForwardSyncRow {
  msgId: string;
  msgSeq?: string;
  msgRandom?: string;
  sendTime?: string;
  elements?: readonly unknown[];
  sourceFormat?: 'native' | 'protocol';
  ntSeqVerified?: boolean;
}

/** 调用方只传当前会话自己的真实消息；返回纯对账结果，渲染时即可隐藏重复占位。 */
export function matchForwardMessages(
  pending: readonly (LocalOutgoingRecord & { resId?: string; at: number })[],
  real: readonly ForwardSyncRow[],
  convId: string,
  consumed: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const matches = new Map<string, string>();
  const used = new Set<string>();
  const candidates = real
    .map((row) => {
      const resIds = new Set<string>();
      let forward = false;
      for (const raw of row.elements ?? []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const element = raw as Record<string, unknown>;
        if (element.type !== 'multiMsg' && element.type !== 'ark') continue;
        const data = element.data;
        const id = forwardResIdOf(
          data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {},
        );
        if (id) resIds.add(id);
        if (id || element.type === 'multiMsg') forward = true;
      }
      return { row, key: `${convId}:${row.msgId}`, resIds, forward };
    })
    .filter((candidate) => candidate.forward);
  for (const item of pending) {
    if (item.convId !== convId || item.state === 'failed') continue;
    const found = candidates.find(({ row, key, resIds }) => {
      if (used.has(key) || (consumed.has(key) && consumed.get(key) !== item.id)) return false;
      if (item.cid && row.msgRandom && row.msgRandom !== '0') return item.cid === row.msgRandom;
      if (item.seqRejected) return false;
      if (item.seq && row.msgSeq && (row.sourceFormat !== 'protocol' || row.ntSeqVerified))
        return item.seq === row.msgSeq;
      const time = Number(row.sendTime);
      return Boolean(
        item.resId &&
          resIds.has(item.resId) &&
          Number.isFinite(time) &&
          time >= Math.floor(item.at / 1000) - 1,
      );
    });
    if (found) {
      used.add(found.key);
      matches.set(item.id, found.key);
    }
  }
  return matches;
}

/**
 * 本机占位是否可以直接扔掉。
 *
 * - 失败占位：服务端明确拒绝或传输层异常，没有 random / seq，也没有别的确认信号；
 * - 未送达占位（`allowRejected`）：回执 seq=0 的静默丢弃。它带着 random（对账主键），
 *   所以不能走失败那套「无 cid」判定 —— 但它同样是一条**没有可信序号**的前端记录，
 *   用户看不到对方是否收到，需要一个「移除」出口。
 *
 * 两者都不碰确认过的发送、漫游和原库记录。
 */
function canDiscardRecord(item: LocalOutgoingRecord, allowRejected = false): boolean {
  if (!item.id.startsWith('optimistic-') || item.fileSync?.fileId) return false;
  const unpositioned = !item.seq || item.seq === '0';
  if (item.state === 'failed') return unpositioned && !item.cid && !item.seqRejected;
  return allowRejected && item.state === 'sent' && unpositioned && Boolean(item.seqRejected);
}

/** 只移除本机失败占位；确认过的发送、漫游和原库记录不走这条路径。 */
export function canDiscardFailedMessage(message: Message): boolean {
  return (
    !message.localSent &&
    message.source !== 'roaming' &&
    canDiscardRecord({
      id: message.id,
      convId: message.conversationId,
      state: message.optimistic ?? 'sent',
      seq: message.msgSeq ?? undefined,
      cid: message.msgRandom,
      seqRejected: message.optimisticRejected,
    })
  );
}

/** 回执 seq=0 的「可能未送达」占位：可被「移除」按钮直接清掉。 */
export function canDiscardRejectedMessage(message: Message): boolean {
  return (
    !message.localSent &&
    message.source !== 'roaming' &&
    message.optimistic === 'sent' &&
    Boolean(message.optimisticRejected) &&
    canDiscardRecord(
      {
        id: message.id,
        convId: message.conversationId,
        state: message.optimistic,
        seq: message.msgSeq ?? undefined,
        cid: message.msgRandom,
        seqRejected: message.optimisticRejected,
      },
      true,
    )
  );
}

export type OutgoingRemoval = <T extends LocalOutgoingRecord>(current: T[]) => T[];

/** 只在当前最新窗口记录已知水位；历史窗口或存在未定位的发送时退回时间定位。 */
export function captureOutgoingAfterSeq(
  convId: string | undefined,
  selection: { id: string; kind: 'direct' | 'group' } | null,
  anchored: boolean,
  loaded: readonly {
    msgSeq?: string;
    sourceFormat?: 'native' | 'protocol';
    ntSeqVerified?: boolean;
  }[],
  outgoing: readonly (readonly LocalOutgoingRecord[])[],
): string | undefined {
  if (!convId || !selection || selection.id !== convId || !anchored) return;
  let last = 0n;
  const accept = (seq?: string) => {
    if (seq && /^[1-9]\d*$/.test(seq) && BigInt(seq) > last) last = BigInt(seq);
  };
  for (const row of loaded) {
    if (selection.kind === 'direct' && row.sourceFormat === 'protocol' && !row.ntSeqVerified)
      continue;
    accept(row.msgSeq);
  }
  for (const rows of outgoing)
    for (const item of rows) {
      if (item.convId !== convId) continue;
      if (item.seq && /^[1-9]\d*$/.test(item.seq) && !item.seqRejected) accept(item.seq);
      else if (!canDiscardRecord(item)) return undefined;
    }
  return last.toString();
}

function removalsFor(
  message: Message,
  convId: string,
  allowRejected: boolean,
): OutgoingRemoval | null {
  const discardable = allowRejected ? canDiscardRejectedMessage : canDiscardFailedMessage;
  if (message.conversationId !== convId || !discardable(message)) return null;
  const id = message.id;
  return <T extends LocalOutgoingRecord>(current: T[]): T[] => {
    const remove = (item: T) =>
      item.id === id && item.convId === convId && canDiscardRecord(item, allowRejected);
    return current.some(remove) ? current.filter((item) => !remove(item)) : current;
  };
}

export function failedOutgoingRemoval(message: Message, convId: string): OutgoingRemoval | null {
  return removalsFor(message, convId, false);
}

/** 「可能未送达」（回执 seq=0）占位的移除；判据同 {@link canDiscardRejectedMessage}。 */
export function rejectedOutgoingRemoval(message: Message, convId: string): OutgoingRemoval | null {
  return removalsFor(message, convId, true);
}

export interface ComposerSubmission {
  id: string;
  draft: NonNullable<Message['composerDraft']>;
  started: boolean;
  accepted: boolean;
  afterSeq?: string;
  at?: number;
}

/** 已出现过的占位可能已被移除或对账，迟到的外层异常不能重新插入它。 */
export function needsFailedPreparation(submission: ComposerSubmission): boolean {
  return !submission.started && !submission.accepted;
}

export function isUnpositionedFailure(message: Message): boolean {
  return message.optimistic === 'failed' && (!message.msgSeq || message.msgSeq === '0');
}

/** 实际消息仍按原序号排列，失败占位仅用自己的创建时间定位，不伪造消息序号。 */
export function mergeOptimisticInto(real: Message[], pending: Message[]): Message[] {
  if (!pending.length) return real;
  const timedFailures = pending.filter(
    (message) => isUnpositionedFailure(message) && Number.isFinite(Date.parse(message.createdAt)),
  );
  const failures = new Set(timedFailures);
  const remaining = pending.filter((message) => !failures.has(message));
  const positioned = remaining.filter((message): message is Message & { msgSeq: string } =>
    Boolean(message.msgSeq),
  );
  const floating = remaining.filter((message) => !message.msgSeq);
  const first = real.find((message) => message.msgSeq);
  const windowMin = first?.msgSeq ? BigInt(first.msgSeq) : null;
  const merged = [...real];
  const stayFloating: Message[] = [];
  for (const item of positioned) {
    const seq = BigInt(item.msgSeq);
    if (windowMin !== null && seq < windowMin) {
      stayFloating.push(item);
      continue;
    }
    const at = merged.findIndex((other) => other.msgSeq && BigInt(other.msgSeq) > seq);
    merged.splice(at < 0 ? merged.length : at, 0, item);
  }
  for (const item of timedFailures.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )) {
    const anchor = item.optimisticAfterSeq;
    const at =
      anchor !== undefined && /^\d+$/.test(anchor)
        ? merged.findIndex((other) => other.msgSeq && BigInt(other.msgSeq) > BigInt(anchor))
        : merged.findIndex((other) => Date.parse(other.createdAt) > Date.parse(item.createdAt));
    merged.splice(at < 0 ? merged.length : at, 0, item);
  }
  return [...merged, ...stayFloating, ...floating];
}
