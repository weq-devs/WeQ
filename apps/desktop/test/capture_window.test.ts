import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import { CaptureWindowHost } from '../src/renderer/src/components/CaptureWindow';
import { useCaptureWindow } from '../src/renderer/src/state/captureWindow';
import { useAppLock } from '../src/renderer/src/state/lock';
import { useRenderDocument } from '../src/renderer/src/lib/renderDocument';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';

const f = vi.hoisted(() => ({
  read: vi.fn(),
  dispose: vi.fn(),
  accounts: [{ uin: '10001', userName: '合成账号', avatarUrl: '', pid: 42 }],
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    wonderfulTools: {
      overview: {
        query: f.read,
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/CapturePanel', () => ({
  CapturePanel: ({ initialUin }: { initialUin: string }) => {
    const owner = useRenderDocument(),
      active = useTabActive();
    const [uin] = useState(initialUin);
    useEffect(
      () => () => {
        f.dispose(uin);
      },
      [uin],
    );
    return createElement(
      'section',
      {
        'aria-label': '完整抓包面板',
        'data-uin': uin,
        'data-active': String(active),
        'data-own-document': String(owner !== document),
      },
      createElement('input', { defaultValue: '' }),
    );
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ ToastHost: () => null }));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCaptureWindow.getState().dismiss();
  useAppLock.getState().unlock();
  f.read.mockReset().mockResolvedValue(f.accounts);
  f.dispose.mockClear();
});
afterEach(() => {
  useCaptureWindow.getState().dismiss();
  useAppLock.getState().unlock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('只放行自有空白抓包窗口，保留系统边框且不获得 Node 或 preload', () => {
  expect(applicationToolPopupOptions('about:blank', 'weq-capture')).toMatchObject({
    title: 'WeQ · QQNT 抓包',
    frame: true,
    minWidth: 640,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  for (const url of ['https://example.invalid', 'about:blank#capture', 'file:///capture.html'])
    expect(applicationToolPopupOptions(url, 'weq-capture')).toBeNull();
});

it('重复打开仅聚焦并保留现场，换来源重新挂载，旧来源关闭请求不能影响新窗口', async () => {
  const popup = new HappyWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const focus = vi.spyOn(popup, 'focus'),
    close = vi.spyOn(popup, 'close');
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(CaptureWindowHost)));
    await act(async () => useCaptureWindow.getState().open('account:source-a', '10001'));
    const first = popup.document.querySelector('[aria-label="完整抓包面板"]')!;
    expect(first.getAttribute('data-own-document')).toBe('true');
    expect(host.querySelector('[aria-label="完整抓包面板"]')).toBeNull();
    const draft = first.querySelector('input')!;
    draft.value = '合成现场';
    await act(async () => useCaptureWindow.getState().open('account:source-a', '10002'));
    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalled();
    expect(popup.document.querySelector('input')?.value).toBe('合成现场');
    expect(first.getAttribute('data-uin')).toBe('10001');
    await act(async () => useCaptureWindow.getState().open('account:source-b', '10002'));
    expect(f.dispose).toHaveBeenCalledWith('10001');
    expect(popup.document.querySelector('input')?.value).toBe('');
    expect(popup.document.querySelector('[data-uin="10002"]')).not.toBeNull();
    act(() => useCaptureWindow.getState().dismiss('account:source-a'));
    expect(close).not.toHaveBeenCalled();
    const reads = f.read.mock.calls.length;
    act(() => useAppLock.getState().lock());
    expect(
      popup.document.querySelector('.weq-capture-window-surface')?.hasAttribute('hidden'),
    ).toBe(true);
    expect(f.read.mock.calls.length).toBe(reads);
    act(() => useCaptureWindow.getState().open('account:source-c', '10003'));
    expect(useCaptureWindow.getState().request?.source).toBe('account:source-b');
    await act(async () => useAppLock.getState().unlock());
    expect(popup.document.querySelector('[data-active="true"]')).not.toBeNull();
    act(() => useCaptureWindow.getState().dismiss('account:source-b'));
    expect(close).toHaveBeenCalledOnce();
    expect(popup.document.querySelector('[aria-label="完整抓包面板"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    popup.close();
  }
});

it('无法开窗时只提供重试，不在设置页内挂载抓包面板', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(CaptureWindowHost)));
    act(() => useCaptureWindow.getState().open('account:source-a', '10001'));
    expect(document.body.textContent).toContain('无法打开 QQNT 抓包窗口');
    expect(document.querySelector('[aria-label="完整抓包面板"]')).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    act(() => useAppLock.getState().lock());
    expect(document.body.textContent).not.toContain('无法打开 QQNT 抓包窗口');
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
  }
});
