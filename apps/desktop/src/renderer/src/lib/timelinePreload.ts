import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';

const MAX_PRELOAD_ROWS = 48;

/** 至少保留原预挂载行数，按已测像素预留一屏，滚动方向提前两屏。 */
export function timelineViewportRange(
  range: Range,
  viewportHeight: number,
  sizeAt: (index: number) => number | undefined,
  direction: 'forward' | 'backward' | null,
): number[] {
  if (!(viewportHeight > 0)) return defaultRangeExtractor(range);
  let start = range.startIndex,
    end = range.endIndex;
  // 短气泡未测行不能固定按 96px 估算，否则预挂载两屏实际只覆盖半屏。
  let estimate = 96;
  for (let index = start; index <= Math.min(end, start + MAX_PRELOAD_ROWS); index++) {
    const measured = sizeAt(index);
    if (measured && measured > 0) estimate = Math.min(estimate, measured);
  }
  const extend = (step: -1 | 1, pixels: number) => {
    let covered = 0,
      count = 0;
    while (count < Math.max(MAX_PRELOAD_ROWS, range.overscan)) {
      const index = step < 0 ? start - 1 : end + 1;
      if (index < 0 || index >= range.count || (count >= range.overscan && covered >= pixels))
        break;
      covered += Math.max(1, sizeAt(index) ?? estimate);
      count++;
      if (step < 0) start = index;
      else end = index;
    }
  };
  extend(-1, viewportHeight * (direction === 'backward' ? 2 : 1));
  extend(1, viewportHeight * (direction === 'forward' ? 2 : 1));
  return defaultRangeExtractor({ ...range, startIndex: start, endIndex: end, overscan: 0 });
}
