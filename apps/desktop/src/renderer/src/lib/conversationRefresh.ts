import { timelineRowKey, timelineSeq, type TimelineRow } from '../../../shared/roaming_timeline';
import { replaceEqualDeep } from '@tanstack/react-query';

/** 有界刷新只覆盖尾部；不把未查询到的旧历史解释为已删除。 */
export function mergeRefreshedWindow<T extends TimelineRow>(
  current: T[],
  refreshed: T[],
  limit: number,
): T[] {
  const previous = new Map(current.map((row) => [timelineRowKey(row), row]));
  refreshed = refreshed.map((row) => replaceEqualDeep(previous.get(timelineRowKey(row)), row));
  if (refreshed.length >= limit) {
    const firstSeq = refreshed.map((row) => timelineSeq(row.msgSeq)).find((seq) => seq !== null);
    const keys = new Set(refreshed.map(timelineRowKey));
    const prefix = current.filter((row) => {
      if (keys.has(timelineRowKey(row))) return false;
      const seq = timelineSeq(row.msgSeq);
      return firstSeq == null || seq === null || seq <= firstSeq;
    });
    refreshed = [...prefix, ...refreshed];
  }
  // 行已按稳定 ID 校准；数组层只比引用，避免插入／删除又按旧位置重建后续行。
  return current.length === refreshed.length && current.every((row, i) => row === refreshed[i])
    ? current
    : refreshed;
}
