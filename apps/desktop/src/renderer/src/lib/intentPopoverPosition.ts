/** 聊天区底边而非窗口底边是输入栏的避让边界。尺寸过大时限制在可用视口。 */
export function intentPopoverPosition(
  target: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  area?: { left: number; right: number; bottom: number },
  mine = false,
) {
  const margin = 12;
  const leftEdge = Math.max(margin, area?.left ?? margin);
  const rightEdge = Math.min(viewport.width - margin, area?.right ?? viewport.width - margin);
  const bottomEdge = Math.min(viewport.height - margin, (area?.bottom ?? viewport.height) - 6);
  const maxWidth = Math.max(1, rightEdge - leftEdge);
  const maxHeight = Math.max(1, bottomEdge - margin);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const below = target.bottom + 6;
  const preferredTop = below + height <= bottomEdge ? below : target.top - height - 6;
  return {
    left: Math.max(
      leftEdge,
      Math.min(mine ? target.right - width : target.left, rightEdge - width),
    ),
    top: Math.max(margin, Math.min(preferredTop, bottomEdge - height)),
    maxWidth,
    maxHeight,
  };
}
