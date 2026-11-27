interface ReplySource {
  msgSeq: string;
  clientSeq?: string;
  senderUin: string;
  senderUid?: string;
  senderAtTime?: { name: string };
  sendTime: string;
  elements: unknown[];
}

export function chooseReplySource<T>(
  candidates: readonly T[],
  data: Record<string, unknown>,
  source: (candidate: T) => { senderUid?: string; senderUin?: string; sendTime?: string | number },
  senderLocalSeq = false,
): T | undefined {
  const uid = typeof data.origSenderUid === 'string' ? data.origSenderUid : '';
  const uin = Number(data.origSenderUin) > 0 ? String(data.origSenderUin) : '';
  const time = Number(data.origMsgTime) > 0 ? String(data.origMsgTime) : undefined;
  const viable = candidates.filter((candidate) => {
    const row = source(candidate);
    if (uid && row.senderUid) return uid === row.senderUid;
    if (uin && row.senderUin && row.senderUin !== '0') return row.senderUin === uin;
    return (
      !senderLocalSeq || (!uid && !uin) || (time !== undefined && String(row.sendTime) === time)
    );
  });
  if (viable.length === 1) return viable[0];
  const bySender = viable.filter((candidate) => {
    const row = source(candidate);
    return uid && row.senderUid ? uid === row.senderUid : Boolean(uin && row.senderUin === uin);
  });
  if (bySender.length === 1) return bySender[0];
  if (time === undefined) return;
  const byTime = (bySender.length ? bySender : viable).filter(
    (row) => String(source(row).sendTime) === time,
  );
  return byTime.length === 1 ? byTime[0] : undefined;
}

export interface ReplyPreviewIndex {
  bySeq: Map<string, ReplySource[]>;
  byClientSeq: Map<string, ReplySource[]>;
}

/** 每轮窗口建一次索引；保留重号候选，由引用的发送者和时间消歧。 */
export function createReplyPreviewIndex(sources: ReplySource[]): ReplyPreviewIndex {
  const bySeq = new Map<string, ReplySource[]>();
  const byClientSeq = new Map<string, ReplySource[]>();
  for (const row of sources) {
    for (const [map, key] of [
      [bySeq, row.msgSeq],
      [byClientSeq, row.clientSeq],
    ] as const) {
      if (!key) continue;
      const matches = map.get(key);
      if (matches) matches.push(row);
      else map.set(key, [row]);
    }
  }
  return { bySeq, byClientSeq };
}

/** 只在唯一匹配时补齐旧引用摘要，不把重号或上一层引用混进来。 */
export function findReplySource(
  kind: 'group' | 'c2c',
  data: Record<string, unknown>,
  sources: ReplySource[] | ReplyPreviewIndex,
): ReplySource | undefined {
  const pointer = Number(kind === 'group' ? data.origMsgSeq : data.origMsgIndex);
  const clientSeq = Number(data.origClientSeq);
  const candidates = Array.isArray(sources)
    ? sources
    : ((pointer > 0
        ? sources.bySeq.get(String(pointer))
        : clientSeq > 0
          ? sources.byClientSeq.get(String(clientSeq))
          : undefined) ?? []);
  const viable = candidates.filter(
    (row) =>
      (pointer > 0
        ? row.msgSeq === String(pointer)
        : clientSeq > 0 && row.clientSeq === String(clientSeq)) &&
      row.elements.some((item) => !(item as { type?: string } | null)?.type?.startsWith('grayTip')),
  );
  return chooseReplySource(viable, data, (row) => row, pointer <= 0 || !Number.isFinite(pointer));
}

export function findReplyPreview(
  kind: 'group' | 'c2c',
  data: Record<string, unknown>,
  sources: ReplySource[] | ReplyPreviewIndex,
): unknown[] | undefined {
  return findReplySource(kind, data, sources)?.elements.filter(
    (item) => (item as { type?: string } | null)?.type !== 'reply',
  );
}
