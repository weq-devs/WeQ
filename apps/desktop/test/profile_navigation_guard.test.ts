import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSettingsNavigation } from '../src/renderer/src/hooks/useSettingsNavigation';

it('资料页可暂停导航，释放后接续已有设置离开检查；卸载后不残留', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  let navigation: ReturnType<typeof useSettingsNavigation>;
  function Probe() {
    navigation = useSettingsNavigation();
    return null;
  }
  const action = vi.fn(),
    order: string[] = [];
  try {
    act(() => root.render(h(Probe)));
    let resume: () => void = () => {};
    const unregister = navigation!.register((next) => {
      order.push('资料');
      resume = next;
    });
    navigation!.guard.current = (next) => {
      order.push('设置');
      next();
    };
    navigation!.navigate(action);
    expect(action).not.toHaveBeenCalled();
    expect(order).toEqual(['资料']);
    resume();
    expect(order).toEqual(['资料', '设置']);
    expect(action).toHaveBeenCalledOnce();
    unregister();
    navigation!.navigate(action);
    expect(order).toEqual(['资料', '设置', '设置']);
    expect(action).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
