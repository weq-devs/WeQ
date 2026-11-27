import { DEFAULT_CHAT_MESSAGE_PREWARM_MIB } from '@weq/service/chat-message-prewarm';
import type { Message } from '../im-template/template/types';
import { messageMediaSize } from './chatMediaSize';

export const TIMELINE_PREWARM_BUDGET = DEFAULT_CHAT_MESSAGE_PREWARM_MIB * 1024 * 1024;
const ROW_BYTES = 512 * 1024;
const ROWS_PER_BATCH = 4;
const NEARBY_ROWS_PER_BATCH = 2;
const MAX_NEARBY_ROWS = 48;
const BYTES_PER_BATCH = 2 * 1024 * 1024;

export function estimateTimelinePrewarmBytes(message: Message, pixelRatio: number): number {
  // 为组件、DOM 和相关缓存预留空间，媒体再按显示尺寸计入像素预算。
  let bytes = ROW_BYTES + message.body.length * 2;
  for (const { type, data } of message.qqElements ?? []) {
    if (type !== 'pic' && type !== 'mface' && type !== 'video') continue;
    const { width, height } = messageMediaSize(type, data ?? {});
    bytes += Math.ceil(width * pixelRatio) * Math.ceil(height * pixelRatio) * 4;
  }
  return bytes;
}

/** 当前视口和正常缓冲由虚拟列表直接处理。这里只安排额外的完整消息。 */
export function advanceTimelinePrewarm({
  keys,
  index,
  bytesAt,
  geometry,
  visibleStart,
  visibleEnd,
  nearStart,
  nearEnd,
  direction,
  velocity,
  current,
  budget = TIMELINE_PREWARM_BUDGET,
  aheadPixels,
}: {
  keys: readonly string[];
  index: ReadonlyMap<string, number>;
  bytesAt: (index: number) => number;
  geometry: readonly { start: number; end: number }[];
  visibleStart: number;
  visibleEnd: number;
  nearStart: number;
  nearEnd: number;
  direction: -1 | 0 | 1;
  velocity: number;
  current: readonly string[];
  budget?: number;
  /** 近端批次只往滚动方向补齐，距离从正常缓冲的边缘起算。 */
  aheadPixels?: number;
}): string[] | undefined {
  const top = geometry[visibleStart]?.start;
  const bottom = geometry[visibleEnd]?.end;
  if (top === undefined || bottom === undefined) return;
  const bias = Math.min(4, 2 + velocity / 2);
  const priority = (position: number) => {
    const row = geometry[position];
    if (!row) return Infinity;
    return position < nearStart
      ? (top - row.end) / (direction === -1 ? bias : 1)
      : (row.start - bottom) / (direction === 1 ? bias : 1);
  };

  const desired = new Set<string>();
  let before = nearStart - 1;
  let after = nearEnd + 1;
  let first = 0;
  let last = keys.length - 1;
  const nearby = aheadPixels !== undefined;
  if (nearby) {
    if (direction === -1) {
      const edge = geometry[nearStart]?.start;
      if (edge === undefined) return;
      last = before;
      first = Math.max(0, nearStart - MAX_NEARBY_ROWS);
      while (first <= last && geometry[first]!.end <= edge - aheadPixels) first++;
      after = keys.length;
    } else {
      const edge = geometry[nearEnd]?.end;
      if (edge === undefined) return;
      first = after;
      last = Math.min(last, geometry.length - 1, nearEnd + MAX_NEARBY_ROWS);
      while (last >= first && geometry[last]!.start >= edge + aheadPixels) last--;
      before = -1;
    }
  }
  let remaining = budget;
  while (before >= first || after <= last) {
    const position =
      after > last || (before >= first && priority(before) <= priority(after)) ? before-- : after++;
    const bytes = bytesAt(position);
    if (bytes > budget) continue;
    if (bytes > remaining) break;
    remaining -= bytes;
    desired.add(keys[position]!);
  }

  const retained = new Set<string>();
  let retainedBytes = 0;
  const obsolete: { key: string; distance: number }[] = [];
  for (const key of current) {
    const position = index.get(key);
    if (position === undefined || (position >= nearStart && position <= nearEnd)) continue;
    retained.add(key);
    retainedBytes += bytesAt(position);
    if (!desired.has(key)) obsolete.push({ key, distance: priority(position) });
  }
  const rowsPerBatch = nearby ? NEARBY_ROWS_PER_BATCH : ROWS_PER_BATCH;
  const next = nearby ? [...desired].find((key) => !retained.has(key)) : undefined;
  const retainLimit = next === undefined ? budget : budget - bytesAt(index.get(next)!);
  let changedRows = 0;
  if (!nearby || retainedBytes > retainLimit) {
    obsolete.sort((left, right) => right.distance - left.distance);
    for (const { key } of obsolete) {
      if (nearby && retainedBytes <= retainLimit) break;
      if (changedRows >= rowsPerBatch && retainedBytes <= budget) break;
      retained.delete(key);
      retainedBytes -= bytesAt(index.get(key)!);
      changedRows++;
    }
  }
  let addedBytes = 0;
  for (const key of desired) {
    if (changedRows >= rowsPerBatch) break;
    if (retained.has(key)) continue;
    const bytes = bytesAt(index.get(key)!);
    if (retainedBytes + bytes > budget || (addedBytes && addedBytes + bytes > BYTES_PER_BATCH))
      break;
    retained.add(key);
    retainedBytes += bytes;
    addedBytes += bytes;
    changedRows++;
  }
  if (!changedRows && retained.size === current.length) return;
  return [...retained];
}
