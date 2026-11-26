import { useLayoutEffect, useRef } from 'react';
import { fadeInSurface } from '../lib/surfaceMotion';

/** 同级页签原地换内容，按需恢复滚动位置。 */
export function useTabPanelMotion(tab: string, restoreScroll = false) {
  const panel = useRef<HTMLDivElement>(null);
  const previous = useRef(tab);
  const scroll = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (previous.current === tab) return;
    previous.current = tab;
    if (restoreScroll && panel.current) panel.current.scrollTop = scroll.current.get(tab) ?? 0;
    const motion = fadeInSurface(panel.current);
    return () => motion?.cancel();
  }, [tab, restoreScroll]);
  return {
    panel,
    rememberScroll() {
      if (restoreScroll && panel.current) scroll.current.set(tab, panel.current.scrollTop);
    },
  };
}
