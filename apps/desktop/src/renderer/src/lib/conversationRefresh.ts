import { timelineRowKey, timelineSeq, type TimelineRow } from '../../../shared/roaming_timeline';

/** 有界刷新只覆盖尾部；不把未查询到的旧历史解释为已删除。 */
export function mergeRefreshedWindow<T extends TimelineRow>(
  current: T[],
  refreshed: T[],
  limit: number,
): T[] {
  if (refreshed.length < limit) return refreshed;
  const firstSeq = refreshed.map((row) => timelineSeq(row.msgSeq)).find((seq) => seq !== null);
  const keys = new Set(refreshed.map(timelineRowKey));
  const prefix = current.filter((row) => {
    if (keys.has(timelineRowKey(row))) return false;
    const seq = timelineSeq(row.msgSeq);
    return firstSeq == null || seq === null || seq <= firstSeq;
  });
  return [...prefix, ...refreshed];
}
