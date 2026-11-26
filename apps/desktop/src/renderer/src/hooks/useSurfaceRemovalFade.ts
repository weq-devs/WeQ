import { useLayoutEffect, type RefObject } from 'react';
import { fadeRemovedSurface } from '../lib/surfaceExit';

/** 让当前组件按原时机卸载，只把最后一帧留给退场动画。 */
export function useSurfaceRemovalFade(
  ref: RefObject<HTMLElement | null>,
  {
    enabled = true,
    pinToViewport = false,
    canShow,
  }: { enabled?: boolean; pinToViewport?: boolean; canShow?: () => boolean } = {},
) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    return () => fadeRemovedSurface(element, { pinToViewport, canShow });
  }, [ref, enabled, pinToViewport, canShow]);
}
