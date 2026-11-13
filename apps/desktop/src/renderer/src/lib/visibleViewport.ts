export function visibleViewport(view: Window | null = window) {
  const viewport = view?.visualViewport;
  const usable = viewport && Math.abs(viewport.scale - 1) <= 0.01 && viewport.height > 0;
  const style = view?.document ? view.getComputedStyle(view.document.documentElement) : null;
  const inset = (side: string) =>
    Math.max(0, Number.parseFloat(style?.getPropertyValue(`--weq-safe-${side}`) ?? '') || 0);
  const leftInset = inset('left'),
    rightInset = inset('right'),
    topInset = inset('top');
  const bottomInset =
    usable && viewport.height < (view?.innerHeight ?? 0) - 120 ? 0 : inset('bottom');
  return {
    left: (usable ? viewport.offsetLeft || 0 : 0) + leftInset,
    top: (usable ? viewport.offsetTop || 0 : 0) + topInset,
    width: Math.max(
      1,
      (usable ? viewport.width || view?.innerWidth || 1024 : view?.innerWidth || 1024) -
        leftInset -
        rightInset,
    ),
    height: Math.max(
      1,
      (usable ? viewport.height : view?.innerHeight || 768) - topInset - bottomInset,
    ),
  };
}
