export function visibleListRange(
  count: number,
  rowHeight: number,
  height: number,
  top: number,
  bufferScreens = 0,
) {
  if (!count) return { start: 0, end: 0 };
  const rows = Math.max(1, Math.ceil(height / rowHeight));
  const buffer = bufferScreens > 0 ? Math.max(8, Math.ceil(rows * bufferScreens)) : 5;
  const start = Math.max(0, Math.min(Math.floor(top / rowHeight) - buffer, count - 1));
  return { start, end: Math.min(count, start + rows + buffer * (bufferScreens > 0 ? 3 : 2)) };
}
