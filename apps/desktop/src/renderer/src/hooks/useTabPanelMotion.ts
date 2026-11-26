import { useLayoutEffect, useRef } from 'react';
import { fadeInSurface } from '../lib/surfaceMotion';

/** 同级页签原地换内容，按需恢复滚动位置。 */
export function useTabPanelMotion<T extends HTMLElement = HTMLDivElement>(
  tab: string,
  restoreScroll = false,
  scrollSelector?: string,
) {
  const panel = useRef<T>(null);
  const previous = useRef(tab);
  const scroll = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (previous.current === tab) return;
    previous.current = tab;
    const scrollNode = scrollContainer(panel.current, scrollSelector);
    if (restoreScroll && scrollNode) scrollNode.scrollTop = scroll.current.get(tab) ?? 0;
    const motion = fadeInSurface(panel.current);
    return () => motion?.cancel();
  }, [tab, restoreScroll, scrollSelector]);
  return {
    panel,
    rememberScroll() {
      if (!restoreScroll) return;
      const scrollNode = scrollContainer(panel.current, scrollSelector);
      if (scrollNode) scroll.current.set(tab, scrollNode.scrollTop);
    },
  };
}

function scrollContainer(panel: HTMLElement | null, selector: string | undefined) {
  if (!selector) return panel;
  return panel?.querySelector<HTMLElement>(selector) ?? panel?.closest<HTMLElement>(selector);
}
