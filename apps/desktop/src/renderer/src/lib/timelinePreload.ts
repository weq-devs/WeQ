import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';
import type { Message } from '../im-template/template/types';
import {
  chatImageGridAt,
  CHAT_IMAGE_GRID_WIDTH,
  CHAT_IMAGE_GRID_GAP,
  messageMediaSize,
} from './chatMediaSize';

const MAX_PRELOAD_ROWS = 48;

export function estimateTimelineRowHeight(message: Message | undefined): number {
  if (!message) return 96;
  let elementsHeight = 0;
  const elements = message.qqElements ?? [];
  for (let index = 0; index < elements.length; index++) {
    const grid = chatImageGridAt(elements, index);
    if (grid) {
      const { count, columns } = grid;
      const tileHeight = (CHAT_IMAGE_GRID_WIDTH - (columns - 1) * CHAT_IMAGE_GRID_GAP) / columns;
      elementsHeight += Math.ceil(count / columns) * (tileHeight + CHAT_IMAGE_GRID_GAP);
      index = grid.end - 1;
      continue;
    }
    const { type, data } = elements[index]!;
    switch (type) {
      case 'pic':
      case 'video':
      case 'mface':
        elementsHeight += messageMediaSize(type, data ?? {}).height + 4;
        break;
      case 'ark':
      case 'multiMsg':
      case 'file':
        elementsHeight += 96;
        break;
      case 'reply':
      case 'ptt':
        elementsHeight += 44;
        break;
    }
  }
  const textHeight = 20 * Math.max(1, Math.ceil(message.body.length / 36));
  return Math.min(800, 28 + Math.max(textHeight, elementsHeight));
}

/** 至少保留原预挂载行数，按已测像素预留一屏，并沿滚动方向扩大缓冲。 */
export function timelineViewportRange(
  range: Range,
  viewportHeight: number,
  sizeAt: (index: number) => number | undefined,
  direction: 'forward' | 'backward' | null,
  estimateAt?: (index: number) => number,
  aheadViewports = 2,
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
      covered += Math.max(1, sizeAt(index) ?? estimateAt?.(index) ?? estimate);
      count++;
      if (step < 0) start = index;
      else end = index;
    }
  };
  extend(-1, viewportHeight * (direction === 'backward' ? aheadViewports : 1));
  extend(1, viewportHeight * (direction === 'forward' ? aheadViewports : 1));
  return defaultRangeExtractor({ ...range, startIndex: start, endIndex: end, overscan: 0 });
}
