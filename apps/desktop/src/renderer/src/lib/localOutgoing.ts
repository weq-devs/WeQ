import type { Message } from '../im-template/template/types';

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

function canDiscardRecord(item: LocalOutgoingRecord): boolean {
  return (
    item.id.startsWith('optimistic-') &&
    item.state === 'failed' &&
    (!item.seq || item.seq === '0') &&
    !item.cid &&
    !item.seqRejected &&
    !item.fileSync?.fileId
  );
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

export function failedOutgoingRemoval(message: Message, convId: string): OutgoingRemoval | null {
  if (message.conversationId !== convId || !canDiscardFailedMessage(message)) return null;
  const id = message.id;
  return <T extends LocalOutgoingRecord>(current: T[]): T[] => {
    const remove = (item: T) => item.id === id && item.convId === convId && canDiscardRecord(item);
    return current.some(remove) ? current.filter((item) => !remove(item)) : current;
  };
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
