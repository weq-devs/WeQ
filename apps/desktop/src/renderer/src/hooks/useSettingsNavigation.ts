import { useCallback, useMemo, useRef } from 'react';

export type SettingsNavigation = (navigate: () => void) => void;

/** 导航入口与设置页共用一个实例，先询问再执行整次页面切换。 */
export function useSettingsNavigation() {
  const guard = useRef<SettingsNavigation | null>(null);
  const navigate = useCallback<SettingsNavigation>((action) => {
    if (guard.current) guard.current(action);
    else action();
  }, []);
  return useMemo(() => ({ guard, navigate }), [navigate]);
}
