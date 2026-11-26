import { useLayoutEffect, useState, type RefObject } from 'react';

/** CSS 负责退场时长和减少动态效果，React 在最后一帧后卸载内容。 */
export function useExitMotion(ref: RefObject<HTMLElement | null>, open: boolean): boolean {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const animations = ref.current?.getAnimations?.();
    if (!animations?.length) {
      setPresent(false);
      return;
    }
    let active = true;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (active) setPresent(false);
    });
    return () => {
      active = false;
    };
  }, [ref, open, present]);
  return open || present;
}
