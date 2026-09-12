/**
 * 报告页里挂件帧动画的 CSS 注入。
 *
 * 与 lib/msgDecorationStyle.ts 的 `injectWidgetCss` 同构（同一批帧图、同一个
 * `steps(1)` 时间轴），但**选择器不同**：那边按 `.message-line[data-widget=…]` 选中
 * 聊天里的头像挂件层，报告里的挂件是自己头像上的 `.weq-dress-face-pendant`，两套
 * 选择器对不上，所以这里单独注一份。
 *
 * 帧图落盘由主进程负责（`prefetchDress` 已解析过），这里只是把 keyframes 和背景图
 * 挂上去；同一 itemId 只注一次。
 */

import { dressPendantFrameUrl } from '../../lib/resourceUrl';

const STYLE_ID = 'weq-report-pendant';
const injected = new Set<number>();

/**
 * 给一款动画挂件注入逐帧 keyframes。静态款（`animated: false`）不需要 CSS ——
 * 页面把它当普通 `<img src>` 画。
 */
export function injectReportPendantCss(widget: {
  animated: boolean;
  itemId: number;
  frameCount?: number;
  frameTimeMs?: number;
  repeat?: number;
}): void {
  if (!widget.animated || !widget.frameCount || !widget.frameTimeMs) return;
  if (injected.has(widget.itemId)) return;
  injected.add(widget.itemId);

  const name = `weq-report-pendant-${widget.itemId}`;
  const step = 100 / widget.frameCount;
  const stops = Array.from({ length: widget.frameCount }, (_, i) => {
    const pct = Math.round(Math.min(i * step, 100) * 100) / 100;
    return `  ${pct}% { background-image: url("${dressPendantFrameUrl(widget.itemId, i + 1)}"); }`;
  });
  const duration = widget.frameCount * widget.frameTimeMs;
  const iterations = (widget.repeat ?? 0) > 0 ? widget.repeat : 'infinite';
  const sel = `.weq-report-root .weq-dress-face-pendant[data-widget="${widget.itemId}"]`;

  // `steps(1)` 让每帧撑满自己的时间段，而不是按不可插值属性的默认「过半才切」语义
  // 把每帧显示时长砍半（同 lib/msgDecorationStyle.ts 的说明）。
  const css = [
    `@keyframes ${name} {`,
    ...stops,
    `}`,
    `${sel} {`,
    `  background-image: url("${dressPendantFrameUrl(widget.itemId, 1)}");`,
    `  animation: ${name} ${duration}ms steps(1) ${iterations};`,
    `}`,
    `@media (prefers-reduced-motion: reduce) { ${sel} { animation: none; } }`,
  ].join('\n');

  let node = document.getElementById(STYLE_ID);
  if (!node) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    document.head.appendChild(node);
  }
  node.textContent = `${node.textContent ?? ''}\n${css}`;
}
