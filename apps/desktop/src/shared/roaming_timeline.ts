export interface TimelineRow {
  msgId: string;
  msgSeq: string;
  source?: 'roaming';
  ntSeqVerified?: boolean;
}

export function timelineSeq(value: string): bigint | null {
  try {
    const seq = BigInt(value);
    return seq > 0n ? seq : null;
  } catch {
    return null;
  }
}

/** Server history IDs can be client randoms, not local snowflake IDs. */
export function timelineRowKey(row: TimelineRow): string {
  return row.source === 'roaming' ? `roaming:${row.msgSeq}:${row.msgId}` : row.msgId;
}

/** Preserve every local row (including gray tips sharing a seq); cache only fills holes. */
export function mergeRoamingTimeline<T extends TimelineRow>(
  kind: 'c2c' | 'group',
  local: T[],
  cached: T[],
  options: { descending?: boolean; limit?: number; min?: bigint; max?: bigint } = {},
): T[] {
  const result = local.filter((row) => row.source !== 'roaming');
  const localSeqs = new Set(result.map((row) => row.msgSeq));
  const added = new Set<string>();
  for (const row of [...local.filter((item) => item.source === 'roaming'), ...cached]) {
    const seq = timelineSeq(row.msgSeq);
    if (
      seq === null ||
      (kind === 'c2c' && row.ntSeqVerified !== true) ||
      (options.min !== undefined && seq < options.min) ||
      (options.max !== undefined && seq > options.max) ||
      localSeqs.has(row.msgSeq) ||
      added.has(row.msgSeq)
    )
      continue;
    added.add(row.msgSeq);
    result.push({ ...row, source: 'roaming' });
  }
  result.sort((a, b) => {
    const left = timelineSeq(a.msgSeq) ?? 0n;
    const right = timelineSeq(b.msgSeq) ?? 0n;
    const order = left < right ? -1 : left > right ? 1 : 0;
    return options.descending ? -order : order;
  });
  return options.limit === undefined ? result : result.slice(0, options.limit);
}
