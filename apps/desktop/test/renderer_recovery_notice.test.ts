import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererRecoveryNotice } from '../src/renderer/src/components/RendererRecoveryNotice';
import { useToast } from '../src/renderer/src/components/Toast';

afterEach(() => {
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.unstubAllGlobals();
});

it('工作区就绪前不确认，严格模式就绪后静默确认，不显示错误横幅', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notice: { id: number } | null = { id: 1 };
  const acknowledgeNotice = vi.fn(async () => {
    notice = null;
  });
  vi.stubGlobal('weq', { rendererRecovery: { getNotice: async () => notice, acknowledgeNotice } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(RendererRecoveryNotice, { ready: false })));
    expect(acknowledgeNotice).not.toHaveBeenCalled();
    expect(notice).toEqual({ id: 1 });
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(RendererRecoveryNotice, { ready: true })),
      ),
    );
    expect(useToast.getState().toasts).toHaveLength(0);
    expect(acknowledgeNotice).toHaveBeenCalledWith(1);
    expect(notice).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('普通启动没有恢复事件时不显示误报', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('weq', {
    rendererRecovery: { getNotice: async () => null, acknowledgeNotice: vi.fn() },
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(RendererRecoveryNotice, { ready: true })));
    expect(useToast.getState().toasts).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});
