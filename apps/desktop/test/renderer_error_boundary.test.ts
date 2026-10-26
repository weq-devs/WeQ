import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererErrorBoundary } from '../src/renderer/src/components/RendererErrorBoundary';

afterEach(() => vi.unstubAllGlobals());

it.each(['render', 'effect'])('%s 异常保留恢复界面，不自动重载或重新执行子树', (phase) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host, { onCaughtError: () => {} });
  const reload = vi.fn();
  const error = new Error('private-message-and-token');
  function Broken(): null {
    useEffect(() => {
      if (phase === 'effect') throw error;
    }, []);
    if (phase === 'render') throw error;
    return null;
  }
  try {
    act(() => root.render(h(RendererErrorBoundary, { reload }, h(Broken))));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('界面遇到异常');
    expect(host.textContent).not.toContain(error.message);
    expect(reload).not.toHaveBeenCalled();
    act(() => root.render(h(RendererErrorBoundary, { reload }, h('div', null, 'retry-child'))));
    expect(host.textContent).not.toContain('retry-child');
    act(() => host.querySelector('button')!.click());
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});

it('正常界面和事件处理不受影响', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const clicked = vi.fn();
  try {
    act(() =>
      root.render(h(RendererErrorBoundary, null, h('button', { onClick: clicked }, '正常'))),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() => host.querySelector('button')!.click());
    expect(clicked).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});
