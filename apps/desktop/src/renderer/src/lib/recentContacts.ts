interface RecentContactSnapshot {
  targetUid: string;
  msgSeq?: string;
  sendTime: string;
}

/** 正文已落到本地但列表通知缺失时，用真实消息水位发现落后的摘要。 */
export function recentContactPreviewIsBehind(
  contact: RecentContactSnapshot,
  message: { msgSeq: string; sendTime: string; source?: 'roaming' },
): boolean {
  if (message.source === 'roaming') return false;
  const time = number(message.sendTime);
  const previous = number(contact.sendTime);
  return time > previous || (time === previous && number(message.msgSeq) > number(contact.msgSeq));
}

const number = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);

/** 最新页和分页目录可能短暂重叠；不能让后面的旧副本把新消息时间覆盖回去。 */
export function mergeRecentContactPages<T extends RecentContactSnapshot>(
  pages: readonly (readonly T[])[],
): T[] {
  const rows = new Map<string, T>();
  for (const page of pages)
    for (const row of page) {
      const old = rows.get(row.targetUid);
      if (
        !old ||
        number(row.msgSeq) > number(old.msgSeq) ||
        (number(row.msgSeq) === number(old.msgSeq) && number(row.sendTime) > number(old.sendTime))
      )
        rows.set(row.targetUid, row);
    }
  return [...rows.values()];
}
