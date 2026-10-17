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

export function floatingFanLayout(point: FloatingPosition, viewport: ViewportSize, count: number) {
  const center = { x: point.x + 22, y: point.y + 22 };
  const dx = center.x < viewport.width / 2 ? 1 : -1;
  const dy = center.y < viewport.height / 2 ? 1 : -1;
  const preferred = (Math.atan2(dy, dx) * 180) / Math.PI;
  const directions = [
    ...new Set([
      preferred,
      dx > 0 ? 0 : 180,
      dy > 0 ? 90 : -90,
      -135,
      -90,
      -45,
      0,
      45,
      90,
      135,
      180,
    ]),
  ];
  let chosen = { radius: 20, start: preferred - 45, span: 90 };
  search: for (const radius of [136, 152, 168, 184, 120, 104, 88, 72, 56, 40, 28, 20]) {
    for (const span of [180, 150, 120, 90]) {
      if (count > 0 && 1.5 * radius * Math.sin(((span / count - 2) * Math.PI) / 360) < 20) continue;
      for (const direction of directions) {
        const start = direction - span / 2;
        const angles = [start, start + span];
        for (let angle = -360; angle <= 360; angle += 90)
          if (angle > start && angle < start + span) angles.push(angle);
        if (
          angles.every((angle) => {
            const p = polar(radius + 4, angle);
            return (
              center.x + p.x >= 8 &&
              center.x + p.x <= viewport.width - 8 &&
              center.y + p.y >= 48 &&
              center.y + p.y <= viewport.height - 8
            );
          })
        ) {
          chosen = { radius, start, span };
          break search;
        }
      }
    }
  }
  const step = chosen.span / Math.max(1, count);
  return {
    ...chosen,
    sectors: Array.from({ length: count }, (_, index) =>
      fanSector(
        chosen.radius,
        chosen.start + index * step + 1,
        chosen.start + (index + 1) * step - 1,
      ),
    ),
  };
}

function polar(radius: number, angle: number): FloatingPosition {
  const radians = (angle * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: radius * Math.sin(radians) };
}
const rounded = (value: number) => Math.round(value * 100) / 100;

/** 视觉用真圆弧，命中区用高密度多边形，保留原生 button 的焦点和可访问名称。 */
function fanSector(radius: number, start: number, end: number) {
  const inner = radius / 2;
  const points: FloatingPosition[] = [];
  for (let index = 0; index <= 16; index++)
    points.push(polar(radius + 2, start + ((end - start) * index) / 16));
  for (let index = 0; index <= 16; index++)
    points.push(polar(inner - 2, end - ((end - start) * index) / 16));
  const minX = Math.floor(Math.min(...points.map((p) => p.x))) - 1;
  const minY = Math.floor(Math.min(...points.map((p) => p.y))) - 1;
  const width = Math.ceil(Math.max(...points.map((p) => p.x))) - minX + 1;
  const height = Math.ceil(Math.max(...points.map((p) => p.y))) - minY + 1;
  const coords = (p: FloatingPosition) => `${rounded(p.x - minX)} ${rounded(p.y - minY)}`;
  const path = `M ${coords(polar(inner, start))} L ${coords(polar(radius, start))} A ${radius} ${radius} 0 0 1 ${coords(polar(radius, end))} L ${coords(polar(inner, end))} A ${inner} ${inner} 0 0 0 ${coords(polar(inner, start))} Z`;
  const center = polar((radius + inner) / 2, (start + end) / 2);
  const iconSize = Math.max(
    8,
    Math.min(20, ((2 * (radius + inner)) / 2) * Math.sin(((end - start) * Math.PI) / 360) - 4),
  );
  return {
    left: minX + 22,
    top: minY + 22,
    width,
    height,
    path,
    clipPath: `polygon(${points.map((p) => `${rounded(p.x - minX)}px ${rounded(p.y - minY)}px`).join(',')})`,
    iconSize,
    iconX: center.x - minX - iconSize / 2,
    iconY: center.y - minY - iconSize / 2,
  };
}
