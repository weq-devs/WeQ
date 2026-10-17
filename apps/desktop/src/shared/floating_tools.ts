export interface FloatingPosition {
  x: number;
  y: number;
}
export interface ViewportSize {
  width: number;
  height: number;
}

export function floatingDockHit(
  point: FloatingPosition,
  slot: { left: number; top: number; width: number; height: number } | null,
): boolean {
  return Boolean(
    slot &&
      slot.width > 0 &&
      slot.height > 0 &&
      point.x >= slot.left - 18 &&
      point.x <= slot.left + slot.width + 18 &&
      point.y >= slot.top - 18 &&
      point.y <= slot.top + slot.height + 18,
  );
}

export function clampFloatingPosition(
  point: FloatingPosition,
  viewport: ViewportSize,
): FloatingPosition {
  const maxX = Math.max(8, viewport.width - 52);
  const maxY = Math.max(8, viewport.height - 52);
  return {
    x: Math.min(maxX, Math.max(8, Number.isFinite(point.x) ? point.x : maxX)),
    y: Math.min(maxY, Math.max(Math.min(48, maxY), Number.isFinite(point.y) ? point.y : maxY)),
  };
}

export function floatingToolbarLayout(
  point: FloatingPosition,
  viewport: ViewportSize,
  count: number,
) {
  const leftSpace = point.x - 14;
  const rightSpace = viewport.width - point.x - 58;
  const side = leftSpace >= rightSpace ? 'left' : 'right';
  const available = Math.max(40, side === 'left' ? leftSpace : rightSpace);
  const columns = Math.max(1, Math.min(count, Math.floor((available - 14) / 40)));
  const vertical = point.y > viewport.height / 2 ? 'up' : 'down';
  const maxHeight = Math.max(44, vertical === 'up' ? point.y - 4 : viewport.height - point.y - 8);
  return { side, vertical, columns, maxHeight } as const;
}
