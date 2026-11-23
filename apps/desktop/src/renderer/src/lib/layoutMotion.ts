export function allowsLayoutMotion(root: HTMLElement) {
  return !root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function visibleLayoutRows(
  root: HTMLElement,
  selector: string,
  keyOf: (element: HTMLElement) => string | undefined,
  bounds = root.getBoundingClientRect(),
) {
  const rows = new Map<string, { element: HTMLElement; top: number }>();
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const key = keyOf(element);
    if (key === undefined) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
      rows.set(key, { element, top: rect.top - bounds.top });
  }
  return rows;
}

export class RowLayoutMotion {
  private animations = new Set<Animation>();

  stop() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }

  shift(element: HTMLElement, offset: number, limit: number) {
    if (Math.abs(offset) < 1 || Math.abs(offset) > limit) return;
    this.play(element, [{ transform: `translateY(${offset}px)` }, { transform: 'none' }]);
  }

  reveal(element: HTMLElement) {
    this.play(element, [{ opacity: 0.75 }, { opacity: 1 }]);
  }

  private play(element: HTMLElement, frames: Keyframe[]) {
    if (!element.animate) return;
    const animation = element.animate(frames, {
      duration: 160,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
    this.animations.add(animation);
    animation.onfinish = () => this.animations.delete(animation);
  }
}
