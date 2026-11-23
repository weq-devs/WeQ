import { useLayoutEffect, useRef } from 'react';

export const outgoingMetadataTiming = { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

/** 同一消息的元信息更新才过渡，首屏和虚拟列表重新挂载时直接显示。 */
export function useOutgoingMetadataMotion<T extends HTMLElement>(
  value: string | null,
  enabled: boolean,
) {
  const ref = useRef<T>(null);
  const previous = useRef(value);
  useLayoutEffect(() => {
    const changed = previous.current !== value;
    previous.current = value;
    const element = ref.current;
    if (!enabled || !changed || !value || !element?.animate) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = element.animate(
      [
        { opacity: 0.35, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'none' },
      ],
      outgoingMetadataTiming,
    );
    return () => animation.cancel();
  }, [enabled, value]);
  return ref;
}
