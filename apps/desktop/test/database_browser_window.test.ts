import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import { DatabaseBrowserWindowHost } from '../src/renderer/src/components/DatabaseBrowserWindow';
import { useDatabaseBrowserWindow } from '../src/renderer/src/state/databaseBrowserWindow';
import { useAppLock } from '../src/renderer/src/state/lock';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';
import { useRenderDocument } from '../src/renderer/src/lib/renderDocument';

vi.mock('../src/renderer/src/components/DatabaseBrowser', () => ({
  default: () =>
    h('input', {
      'aria-label': '合成数据库浏览',
      'data-active': String(useTabActive()),
      'data-own-document': String(useRenderDocument() !== document),
    }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ ToastHost: () => null }));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));
afterEach(() => {
  useDatabaseBrowserWindow.getState().dismiss();
  useAppLock.getState().unlock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('数据库浏览只放行登记的系统窗口，保留主进程现有权限配置', () => {
  expect(applicationToolPopupOptions('about:blank', 'weq-database-browser')).toMatchObject({
    width: 1180,
    height: 780,
    frame: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  expect(
    applicationToolPopupOptions('https://example.invalid/', 'weq-database-browser'),
  ).toBeNull();
});

it('重复打开聚焦原窗并保留现场；锁定时停用，关闭设置不卸载全局窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const focus = vi.spyOn(popup, 'focus');
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(h(DatabaseBrowserWindowHost)));
    await act(async () => useDatabaseBrowserWindow.getState().open());
    const input = popup.document.querySelector<HTMLInputElement>('input')!;
    expect(input.dataset.ownDocument).toBe('true');
    input.value = '保留查询';
    await act(async () => useDatabaseBrowserWindow.getState().open());
    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalled();
    expect(input.value).toBe('保留查询');
    act(() => useAppLock.getState().lock());
    expect(input.dataset.active).toBe('false');
    act(() => useAppLock.getState().unlock());
    expect(input.dataset.active).toBe('true');
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    popup.close();
  }
});

it('弹窗不可用时使用全屏工具页', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'open').mockReturnValue(null);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(h(DatabaseBrowserWindowHost));
      useDatabaseBrowserWindow.getState().open();
    });
    expect(
      document.querySelector('[aria-label="数据库浏览"]') ??
        host.querySelector('[aria-label="数据库浏览"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('input') ?? document.querySelector('[aria-label="合成数据库浏览"]'),
    ).not.toBeNull();
    const close = host.querySelector<HTMLButtonElement>('[aria-label="关闭数据库浏览"]');
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(useDatabaseBrowserWindow.getState().request).toBeNull();
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
  }
});
