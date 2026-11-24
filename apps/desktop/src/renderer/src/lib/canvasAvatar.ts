/** A two-stroke silhouette that stays legible at small node sizes. */
export function drawPersonGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.22, radius * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + radius * 0.62, radius * 0.62, Math.PI * 1.08, Math.PI * 1.92);
  ctx.fill();
  ctx.restore();
}
