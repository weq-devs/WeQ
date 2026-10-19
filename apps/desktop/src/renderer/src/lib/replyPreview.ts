interface ReplySource {
  msgSeq: string;
  clientSeq?: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
}

/** 只在唯一匹配时补齐旧引用摘要，不把重号或上一层引用混进来。 */
export function findReplyPreview(
  kind: 'group' | 'c2c',
  data: Record<string, unknown>,
  sources: ReplySource[],
): unknown[] | undefined {
  const pointer = Number(kind === 'group' ? data.origMsgSeq : data.origMsgIndex);
  const clientSeq = Number(data.origClientSeq);
  const matches = sources.filter(
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
