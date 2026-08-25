/**
 * 延迟显示 `loading` 状态：持续 `delayMs` 毫秒后才显示加载占位，避免闪烁
 * skeleton 随 `loading` 变为 false 时立即隐藏
 */

import { useEffect, useState } from 'react';

export function useDebouncedLoading(loading: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [loading, delayMs]);

  return visible;
}
