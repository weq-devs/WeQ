import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererRecoveryNotice } from '../src/renderer/src/components/RendererRecoveryNotice';
import { useToast } from '../src/renderer/src/components/Toast';

afterEach(() => {
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.unstubAllGlobals();
});

it('React 严格模式只显示一条错误横幅，挂载后领取，不因订阅迟于加载而丢失', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notice: { id: number } | null = { id: 1 };
  const acknowledgeNotice = vi.fn(async () => {
    notice = null;
  });
  vi.stubGlobal('weq', { rendererRecovery: { getNotice: async () => notice, acknowledgeNotice } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(RendererRecoveryNotice))),
    );
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(useToast.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: '界面崩溃，已自动恢复',
    });
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
    await act(async () => root.render(createElement(RendererRecoveryNotice)));
    expect(useToast.getState().toasts).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});
