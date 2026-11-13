import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useEventContextValue } from '../src/renderer/src/hooks/useEventContextValue';

it('未变数据不通知 Context，稳定事件仍调用最新已提交实现', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  type Value = { count: number; select: () => number };
  let observed: Value;
  function Fixture({ value }: { value: Value }) {
    observed = useEventContextValue(value);
    return null;
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  const render = (count: number, result: number) =>
    act(() => root.render(createElement(Fixture, { value: { count, select: () => result } })));
  try {
    render(1, 1);
    const first = observed!;
    render(1, 2);
    expect(observed!).toBe(first);
    expect(first.select()).toBe(2);
    render(2, 3);
    expect(observed!).not.toBe(first);
    expect(first.select()).toBe(3);
    expect(observed!.count).toBe(2);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
