export type ScrollToPosition = (top: number, behavior: 'instant' | 'smooth') => void;

/** 只滚动内容容器，避免影响它外层的工作区或另一个窗格。 */
export function scrollToNewest(
  container: HTMLElement,
  item?: Element | null,
  scroll?: ScrollToPosition | null,
): void {
  const top = item
    ? container.scrollTop + item.getBoundingClientRect().top - container.getBoundingClientRect().top
    : 0;
  const reduceMotion = container.ownerDocument.defaultView?.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  const behavior = reduceMotion ? 'instant' : 'smooth';
  if (scroll) scroll(top, behavior);
  else container.scrollTo({ top, behavior });
}
