/**
 * 界面级转场：视图切换、整页/浮层进场的统一节奏。
 *
 * 元素级的弹窗、菜单、Toast 动效由 CSS 关键帧负责（见 `styles/index.css` 的
 * `weq-anim-*`）。这里只补 CSS 做不到的两件事：
 *
 * 1. **内容原地替换**：主视图切换时 DOM 节点不重建，CSS 动画不会重放，
 *    只能用 Web Animations 在切换后跑一次淡入（与 `MobileNavigationRuntime`
 *    手机端返回同一套 120ms 做法）。
 * 2. **统一的减少动态效果判断**：新动效必须和现有 113 处 `prefers-reduced-motion`
 *    一样能关掉。
 *
 * 数值与 `styles/index.css` 的 `--weq-motion-*` 保持一致，改一处要同步另一处。
 */

export const surfaceMotionTiming = {
  /** 视图/内容原地替换：高频操作，只做最短的淡入。 */
  switch: 120,
  /** 面板、浮层、列表行进场。 */
  enter: 160,
  /** 关闭后短暂收尾，交互由调用方立即释放。 */
  exit: 120,
  /** 整页进场。 */
  page: 220,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export function prefersReducedMotion(element: Element | null | undefined): boolean {
  const view = element?.ownerDocument.defaultView;
  return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * 内容原地替换后跑一次淡入。
 *
 * 节点和滚动位置都不动，只改合成层的 opacity：不影响布局、快照恢复和虚拟列表。
 * 从 `from` 起步而不是 0，避免大面积内容整块闪掉再亮起。
 */
export function fadeInSurface(
  element: Element | null | undefined,
  { from = 0.86, duration = surfaceMotionTiming.switch }: { from?: number; duration?: number } = {},
): void {
  const target = element instanceof HTMLElement ? element : null;
  if (!target || typeof target.animate !== 'function' || prefersReducedMotion(target)) return;
  const animation = target.animate([{ opacity: from }, { opacity: 1 }], {
    duration,
    easing: 'ease-out',
  });
  void animation.finished.catch(() => {});
}
