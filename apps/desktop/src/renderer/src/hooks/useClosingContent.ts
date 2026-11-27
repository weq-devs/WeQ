import { useLayoutEffect, useState } from 'react';
import { layoutMotionTiming } from '../lib/layoutMotion';

/** 短暂保留退场画面，切换作用域和减少动态效果时立即清空。 */
export function useClosingContent<T>(
  value: T | null,
  scope: string | number | undefined,
  duration = layoutMotionTiming.duration,
) {
  const [last, remember] = useState({ value, scope });
  if (last.scope !== scope || (value !== null && last.value !== value)) remember({ value, scope });
  const retained = last.scope === scope ? last.value : null;
  const closing = value === null && retained !== null;

  useLayoutEffect(() => {
    if (!closing) return;
    const clear = () =>
      remember((current) => (current === last ? { value: null, scope } : current));
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      clear();
      return;
    }
    // 样式过渡可在下一帧起动，等实际退场后再卸载。
    const timer = window.setTimeout(clear, duration + 34);
    return () => window.clearTimeout(timer);
  }, [closing, last, scope, duration]);

  return value ?? retained;
}
