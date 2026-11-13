/** 上下文条数不包含目标消息；奇数时多取一条较早的消息。 */
export function missingContextRange(targetSeq: string, count: number) {
  if (!/^[1-9]\d*$/.test(targetSeq) || !Number.isInteger(count) || count < 1 || count > 500)
    return null;
  const target = Number(targetSeq);
  if (!Number.isSafeInteger(target) || target > 0xffffffff) return null;
  return {
    startSeq: Math.max(1, target - Math.ceil(count / 2)),
    endSeq: Math.min(0xffffffff, target + Math.floor(count / 2)),
  };
}

export async function fetchMissingContext<T>(
  targetSeq: string,
  count: number,
  fetchPage: (range: {
    startSeq: number;
    endSeq: number;
  }) => Promise<
    { ok: true; messages: T[]; nextStartSeq: number | null } | { ok: false; message: string }
  >,
  isCurrent: () => boolean,
): Promise<T[]> {
  const range = missingContextRange(targetSeq, count);
  if (!range) return [];
  const rows: T[] = [];
  let startSeq = range.startSeq;
  while (startSeq <= range.endSeq && isCurrent()) {
    const page = await fetchPage({ startSeq, endSeq: range.endSeq });
    if (!isCurrent()) return [];
    if (!page.ok) throw new Error(page.message);
    rows.push(...page.messages);
    if (page.nextStartSeq === null) break;
    if (page.nextStartSeq <= startSeq) throw new Error('漫游分页未前进');
    startSeq = page.nextStartSeq;
  }
  return isCurrent() ? rows : [];
}
