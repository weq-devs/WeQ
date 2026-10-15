import type { BackfillSeqWindow } from './msg_backfill';
import type { GapFetchedMessage } from '../gap_history';
import type { ExportTimeRange } from './types';

export function sequenceCoverage(
  window: BackfillSeqWindow,
  cached: readonly GapFetchedMessage[],
  kind: 'group' | 'c2c',
  conv: string,
  range?: ExportTimeRange,
) {
  const known = new Set(window.seqs.filter((seq) => seq > 0n));
  for (const row of cached)
    if (
      row.conv === conv &&
      row.kind === kind &&
      (kind === 'group' || row.ntSeqVerified === true) &&
      /^\d+$/.test(row.msgSeq) &&
      BigInt(row.msgSeq) > 0n &&
      (range?.start == null || Number(row.sendTime) >= range.start) &&
      (range?.end == null || Number(row.sendTime) <= range.end)
    )
      known.add(BigInt(row.msgSeq));
  if (window.below !== null && window.below > 0n) known.add(window.below);
  if (window.above !== null && window.above > 0n) known.add(window.above);
  const seqs = [...known].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ranges: Array<{ start: string; end: string }> = [];
  let rangeCount = 0;
  for (let i = 1; i < seqs.length; i++)
    if (seqs[i]! - seqs[i - 1]! > 1n) {
      rangeCount++;
      if (ranges.length < 200)
        ranges.push({ start: String(seqs[i - 1]! + 1n), end: String(seqs[i]! - 1n) });
    }
  return {
    observedAt: Date.now(),
    basis: 'candidate sequence gaps between observed anchors; not proof of missing server messages',
    ranges,
    rangeCount,
    rangeListTruncated: rangeCount > ranges.length,
    beforeOldestObserved: 'unknown',
  };
}
