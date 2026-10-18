export interface TimelineRow {
  sourceFormat?: 'native' | 'protocol';
  sendTime?: string;
  msgRandom?: string;
  localSent?: boolean;
  senderUid?: string;
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
  return row.source === 'roaming'
    ? `roaming:${row.sourceFormat ? `${row.sourceFormat}:` : ''}${row.msgSeq}:${row.msgId}`
    : row.msgId;
}

/** Fill the currently loaded window without extending it or re-anchoring history to latest. */
export function mergeRoamingWindow<T extends TimelineRow>(
  kind: 'c2c' | 'group',
  local: T[],
  cached: T[],
): T[] {
  const first = local.find((row) => timelineSeq(row.msgSeq) !== null);
  const last = local.findLast((row) => timelineSeq(row.msgSeq) !== null);
  if (!first || !last) return local;
  const incoming = cached.filter((row) => {
    const seq = timelineSeq(row.msgSeq);
    return seq !== null && seq >= BigInt(first.msgSeq) && seq <= BigInt(last.msgSeq);
  });
  return incoming.length ? mergeRoamingTimeline(kind, local, incoming) : local;
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
  const localIds = new Set(result.map((row) => row.msgId));
  const identity = (row: T): string | null =>
    row.msgRandom && row.msgRandom !== '0' && row.senderUid
      ? `${row.msgSeq}:${row.msgRandom}:${row.senderUid}`
      : null;
  const localIdentities = new Set(result.map(identity).filter(Boolean));
  const nativeRandoms = new Set(
    [...local, ...cached]
      .filter((row) => row.sourceFormat && row.msgRandom && row.msgRandom !== '0')
      .map((row) => `${row.msgSeq}:${row.msgRandom}:${row.senderUid ?? ''}`),
  );
  const added = new Set<string>();
  const candidates = [...local.filter((item) => item.source === 'roaming'), ...cached];
  const syncedIdentities = new Set(
    candidates
      .filter((row) => !row.localSent)
      .map(identity)
      .filter(Boolean),
  );
  for (const row of candidates) {
    const seq = timelineSeq(row.msgSeq);
    if (
      seq === null ||
      (row.localSent && identity(row) !== null && syncedIdentities.has(identity(row))) ||
      (kind === 'c2c' && row.ntSeqVerified !== true) ||
      (options.min !== undefined && seq < options.min) ||
      (options.max !== undefined && seq > options.max) ||
      (row.sourceFormat
        ? localIds.has(row.msgId) ||
          (row.sourceFormat === 'protocol' &&
            identity(row) !== null &&
            localIdentities.has(identity(row)))
        : localSeqs.has(row.msgSeq) ||
          nativeRandoms.has(
            `${row.msgSeq}:${row.msgRandom || row.msgId}:${row.senderUid ?? ''}`,
          )) ||
      added.has(row.sourceFormat ? `${row.msgSeq}:${row.msgId}` : row.msgSeq)
    )
      continue;
    added.add(row.sourceFormat ? `${row.msgSeq}:${row.msgId}` : row.msgSeq);
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
