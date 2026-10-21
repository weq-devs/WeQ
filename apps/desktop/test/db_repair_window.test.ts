import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import { DbRepairWindowHost } from '../src/renderer/src/components/DbRepairWindow';
import { useDbRepairWindow } from '../src/renderer/src/state/dbRepairWindow';
import { useRenderDocument } from '../src/renderer/src/lib/renderDocument';
import { useAppLock } from '../src/renderer/src/state/lock';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { useUtils: () => ({ bootstrap: { listAccountConfigs: { invalidate: async () => {} } } }) },
}));
vi.mock('../src/renderer/src/components/DbRepairPanel', () => ({
  DbRepairPanel: ({ currentUin }: { currentUin: string }) => {
    const owner = useRenderDocument();
    return h(
      'section',
      {
        'aria-label': '完整数据库修复',
        'data-uin': currentUin,
        'data-own-document': String(owner !== document),
      },
      '体检／修复／记录／回滚',
    );
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ ToastHost: () => null }));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));

afterEach(() => {
  useDbRepairWindow.getState().dismiss();
  useAppLock.getState().unlock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('原生修复窗有系统边框，严格限制为自有空白页，不获得 Node 或 preload', () => {
  expect(applicationToolPopupOptions('https://example.invalid', 'weq-db-repair')).toBeNull();
  expect(applicationToolPopupOptions('about:blank', 'other')).toBeNull();
  expect(applicationToolPopupOptions('about:blank', 'weq-db-repair')).toMatchObject({
    frame: true,
    title: 'WeQ · 数据库修复',
    minWidth: 640,
    minHeight: 480,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: undefined,
    },
  });
  expect(applicationToolPopupOptions('about:blank', 'weq-compose')).toMatchObject({ frame: false });
});

it('完整修复 UI 挂在系统子文档，重复请求聚焦并保留原账号，锁屏隐藏内容，卸载关闭窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const focus = vi.spyOn(popup, 'focus');
  const close = vi.spyOn(popup, 'close');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(DbRepairWindowHost)));
    act(() => useDbRepairWindow.getState().open({ uin: '10001', name: '合成账号', avatarUrl: '' }));
    expect(open).toHaveBeenCalledWith(
      'about:blank',
      'weq-db-repair',
      'popup,width=1060,height=780',
    );
    const panel = popup.document.querySelector('[aria-label="完整数据库修复"]')!;
    expect(panel.getAttribute('data-uin')).toBe('10001');
    expect(panel.getAttribute('data-own-document')).toBe('true');
    expect(host.querySelector('[aria-label="完整数据库修复"]')).toBeNull();
    expect(popup.document.title).toBe('WeQ · 数据库修复');
    act(() =>
      useDbRepairWindow.getState().open({ uin: '10002', name: '另一个账号', avatarUrl: '' }),
    );
    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalled();
    expect(panel.getAttribute('data-uin')).toBe('10001');
    act(() => useAppLock.getState().lock());
    expect(popup.document.querySelector('.weq-db-repair-native')?.hasAttribute('hidden')).toBe(
      true,
    );
    expect(popup.document.body.textContent).toContain('应用已锁定');
    act(() => useAppLock.getState().unlock());
    expect(popup.document.querySelector('.weq-db-repair-native')?.hasAttribute('hidden')).toBe(
      false,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    expect(close).toHaveBeenCalled();
    popup.close();
  }
});

it('系统窗口被阻止时显示重试状态，不启动修复面板或体检', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'open').mockReturnValue(null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(DbRepairWindowHost)));
    act(() => useDbRepairWindow.getState().open({ uin: '10001', name: '合成账号', avatarUrl: '' }));
    expect(document.querySelector('[aria-label="完整数据库修复"]')).toBeNull();
    expect(document.body.textContent).toContain('无法打开数据库修复窗口');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
