import type { SelectionGap } from './messageSelection';

/** 按起点排序并保存前缀最大终点；查询保持「某一个原区间完整包含」的语义。 */
export function createSelectionGapIndex(gaps: readonly SelectionGap[]) {
  const ranges = gaps.map((gap) => ({
    start: BigInt(gap.previousSeq),
    end: BigInt(gap.currentSeq),
  }));
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const ends: bigint[] = [];
  for (const range of ranges) {
    const previous = ends.at(-1);
    ends.push(previous !== undefined && previous > range.end ? previous : range.end);
  }
  const lastStart = (value: bigint, inclusive: boolean) => {
    let low = 0,
      high = ranges.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2),
        start = ranges[middle]!.start;
      if (start < value || (inclusive && start === value)) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  return {
    containsGap(gap: SelectionGap): boolean {
      const index = lastStart(BigInt(gap.previousSeq), true);
      return index >= 0 && ends[index]! >= BigInt(gap.currentSeq);
    },
    containsSequence(sequence: bigint): boolean {
      const index = lastStart(sequence, false);
      return index >= 0 && ends[index]! > sequence;
    },
  };
}
