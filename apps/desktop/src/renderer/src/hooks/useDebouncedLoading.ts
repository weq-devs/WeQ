/**
 * ??????`loading` ???? `delayMs` ??????????????
 * skeleton ????`loading` ?? false ??????
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
