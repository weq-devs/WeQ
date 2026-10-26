interface ReplySource {
  msgSeq: string;
  clientSeq?: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
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
export function findReplyPreview(
  kind: 'group' | 'c2c',
  data: Record<string, unknown>,
  sources: ReplySource[] | ReplyPreviewIndex,
): unknown[] | undefined {
  const pointer = Number(kind === 'group' ? data.origMsgSeq : data.origMsgIndex);
  const clientSeq = Number(data.origClientSeq);
  const candidates = Array.isArray(sources)
    ? sources
    : ((pointer > 0
        ? sources.bySeq.get(String(pointer))
        : clientSeq > 0
          ? sources.byClientSeq.get(String(clientSeq))
          : undefined) ?? []);
  const matches = candidates.filter(
    (row) =>
      (pointer > 0
        ? row.msgSeq === String(pointer)
        : clientSeq > 0 && row.clientSeq === String(clientSeq)) &&
      (!Number(data.origSenderUin) || row.senderUin === String(data.origSenderUin)) &&
      (!Number(data.origMsgTime) || row.sendTime === String(data.origMsgTime)),
  );
  return matches.length === 1
    ? matches[0]!.elements.filter((item) => (item as { type?: string } | null)?.type !== 'reply')
    : undefined;
}
