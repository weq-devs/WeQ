import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererErrorBoundary } from '../src/renderer/src/components/RendererErrorBoundary';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));

afterEach(() => {
  delete window.weqRemoteStartup;
  delete window.weqRemoteStartupRetrying;
  vi.unstubAllGlobals();
});

it('Remote 启动渲染异常立即上报，不把原始错误暴露给手机壳', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host, { onCaughtError: () => {} });
  window.weqRemoteStartup = { state: 'loading', message: '正在加载界面模块' };
  function Broken(): null {
    throw Error('private-message-and-token');
  }
  try {
    act(() => root.render(h(RendererErrorBoundary, null, h(Broken))));
    expect(window.weqRemoteStartup?.state).toBe('error');
    expect(window.weqRemoteStartup?.message).not.toContain('private-message-and-token');
  } finally {
    act(() => root.unmount());
  }
});

it.each([true, false])('资源正在重试或已经就绪时不误报启动失败：retrying=%s', (retrying) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host, { onCaughtError: () => {} });
  const state = { state: retrying ? ('loading' as const) : ('ready' as const) };
  window.weqRemoteStartup = state;
  window.weqRemoteStartupRetrying = retrying;
  function Broken(): null {
    throw Error('fixture');
  }
  try {
    act(() => root.render(h(RendererErrorBoundary, null, h(Broken))));
    expect(window.weqRemoteStartup).toBe(state);
  } finally {
    act(() => root.unmount());
  }
});

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
