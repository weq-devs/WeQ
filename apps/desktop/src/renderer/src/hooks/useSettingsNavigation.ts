import { useCallback, useMemo, useRef } from 'react';

export type SettingsNavigation = (navigate: () => void) => void;

/** 导航入口与设置页共用一个实例，先询问再执行整次页面切换。 */
export function useSettingsNavigation() {
  const guard = useRef<SettingsNavigation | null>(null);
  const surfaces = useRef(new Set<SettingsNavigation>());
  const register = useCallback((surface: SettingsNavigation) => {
    surfaces.current.add(surface);
    return () => {
      surfaces.current.delete(surface);
    };
  }, []);
  const navigate = useCallback<SettingsNavigation>((action) => {
    const pending = [...surfaces.current];
    const next = () => {
      const surface = pending.shift();
      if (surface) surface(next);
      else if (guard.current) guard.current(action);
      else action();
    };
    next();
  }, []);
  return useMemo(() => ({ guard, navigate, register }), [navigate, register]);
}
