import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useTabActive } from '../RetainedTabs.shared';
import { type SearchPosition, restoreSearchPosition } from './searchPosition.shared';

export function SearchPositionRestore({
  container,
  position,
}: {
  container: RefObject<HTMLElement | null>;
  position?: SearchPosition;
}): null {
  const active = useTabActive();
  const pending = useRef(position);
  useLayoutEffect(() => {
    if (!active || !pending.current) return;
    // 工作区的激活聚焦先完成，再恢复原命中；隐藏页不会提前消耗现场。
    const frame = window.requestAnimationFrame(() => {
      const node = container.current;
      if (!node || node.closest('[hidden], [inert]') || !pending.current) return;
      restoreSearchPosition(node, pending.current);
      pending.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, container]);
  return null;
}
export type { SearchPosition } from './searchPosition.shared';
