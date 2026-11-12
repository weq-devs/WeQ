import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import {
  groupResourceWindowName,
  readGroupResourceWindowName,
} from '../src/shared/group_resource_window';
import { useGroupResourceWindows } from '../src/renderer/src/hooks/useGroupResourceWindows';
import { useRenderDocument } from '../src/renderer/src/lib/renderDocument';
import { useAppLock } from '../src/renderer/src/state/lock';
import {
  WorkspacePages,
  WorkspaceContent,
  WorkspacePage,
  useWorkspaceActiveTitle,
} from '../src/renderer/src/components/WorkspacePages';

const state = vi.hoisted(() => ({ inline: false }));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/lib/remoteClient', () => ({ isRemoteClient: () => state.inline }));
vi.mock('../src/renderer/src/lib/responsiveLayout', () => ({
  isSingleColumnLayout: () => state.inline,
  isMobileClient: () => false,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ ToastHost: () => null }));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children, presentation }: { children: unknown; presentation: string }) =>
    createElement('main', { 'data-presentation': presentation }, children as never),
}));
vi.mock('../src/renderer/src/components/GroupAlbumDialog', () => ({
  GroupAlbumDialog: ({ groupCode, onClose }: { groupCode: string; onClose: () => void }) => {
    const [page, setPage] = useState(false);
    return createElement(
      'section',
      {
        'data-kind': 'albums',
        'data-group': groupCode,
        'data-own-document': String(useRenderDocument() !== document),
      },
      createElement('input', { defaultValue: '' }),
      createElement('button', { onClick: onClose }, '关闭'),
      createElement(
        'button',
        { 'data-open-local-page': true, onClick: () => setPage(true) },
        '内部页面',
      ),
      page
        ? createElement(
            WorkspacePage,
            {
              title: '资源内部页面',
              onClose: () => setPage(false),
            },
            '内部内容',
          )
        : null,
    );
  },
}));
vi.mock('../src/renderer/src/components/GroupFileDialog', () => ({
  GroupFileDialog: ({ groupCode, onClose }: { groupCode: string; onClose: () => void }) => {
    const [openedGroup] = useState(groupCode);
    return createElement(
      'section',
      {
        'data-kind': 'files',
        'data-group': openedGroup,
        'data-own-document': String(useRenderDocument() !== document),
      },
      createElement('button', { onClick: onClose }, '关闭'),
    );
  },
}));

let controls: ReturnType<typeof useGroupResourceWindows>;
function Host({ ownerKey }: { ownerKey: string }) {
  controls = useGroupResourceWindows({ ownerKey });
  return createElement('div', null, controls.windows);
}
const popups: HappyWindow[] = [];
function MainNavigationProbe() {
  return createElement('output', { 'data-main-page': true }, useWorkspaceActiveTitle() ?? '主聊天');
}
it('资源内部页面只使用所属窗口导航，不接管主窗口页面', async () => {
  vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          WorkspacePages,
          {
            navigationKey: 'main',
          },
          [
            createElement(MainNavigationProbe, { key: 'probe' }),
            createElement(WorkspaceContent, { key: 'content' }, '主窗口内容'),
            createElement(Host, { key: 'windows', ownerKey: '10001:source-a' }),
          ],
        ),
      ),
    );
    act(() => controls.open({ kind: 'albums', groupCode: '123', groupName: '测试群' }));
    act(() =>
      popups[0]!.document.querySelector<HTMLButtonElement>('[data-open-local-page]')!.click(),
    );
    expect(host.querySelector('[data-main-page]')?.textContent).toBe('主聊天');
    expect(host.textContent).not.toContain('内部内容');
    expect(popups[0]!.document.body.textContent).toContain('内部内容');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.inline = false;
  useAppLock.getState().unlock();
});
afterEach(() => {
  for (const popup of popups.splice(0)) popup.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('系统窗口只放行明确的账号来源、群号和资源种类', () => {
  const name = groupResourceWindowName('10001:source/a', '123456', 'albums');
  expect(readGroupResourceWindowName(name)).toEqual({
    owner: '10001:source/a',
    groupCode: '123456',
    kind: 'albums',
  });
  expect(applicationToolPopupOptions('about:blank', name)).toMatchObject({
    width: 1060,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    frame: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  for (const invalid of [
    'weq-group-resource:albums::123456',
    'weq-group-resource:albums:%broken:123456',
    'weq-group-resource:albums:source:0',
    'weq-group-resource:unknown:source:123456',
  ])
    expect(applicationToolPopupOptions('about:blank', invalid)).toBeNull();
  expect(applicationToolPopupOptions('https://example.invalid/', name)).toBeNull();
});

it('同步创建窗口，同群复用不清空现场，不同群和功能并存，来源切换统一关闭', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Host, { ownerKey: '10001:source-a' })));
    expect(open).not.toHaveBeenCalled();
    act(() => {
      controls.open({ kind: 'albums', groupCode: '123', groupName: '合成甲群' });
      expect(open).toHaveBeenCalledOnce();
    });
    const first = popups[0]!;
    const focus = vi.spyOn(first, 'focus');
    expect(first.document.querySelector('[data-own-document="true"]')).not.toBeNull();
    expect(document.querySelector('[data-group="123"]')).toBeNull();
    first.document.querySelector('input')!.value = '保留浏览状态';
    act(() => controls.open({ kind: 'albums', groupCode: '123', groupName: '合成甲群' }));
    expect(open).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(first.document.querySelector('input')!.value).toBe('保留浏览状态');
    act(() => controls.open({ kind: 'files', groupCode: '456', groupName: '合成乙群' }));
    act(() => controls.open({ kind: 'files', groupCode: '123', groupName: '合成甲群' }));
    expect(open).toHaveBeenCalledTimes(3);
    expect(popups[1]!.document.querySelector('[data-group="456"]')).not.toBeNull();
    expect(first.document.title).toBe('合成甲群 · 群相册');
    act(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await act(async () => Promise.resolve());
    expect(first.document.documentElement.getAttribute('data-theme')).toBe('dark');
    const closes = popups.map((popup) => vi.spyOn(popup, 'close'));
    act(() => root.render(createElement(Host, { ownerKey: '10001:source-b' })));
    await act(async () => Promise.resolve());
    for (const close of closes) expect(close).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    document.documentElement.removeAttribute('data-theme');
  }
});

it('窄屏不调用系统开窗，弹窗拦截后使用应用内整页，关闭主宿主释放系统窗口', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Host, { ownerKey: '10001:source-a' })));
    state.inline = true;
    act(() => controls.open({ kind: 'files', groupCode: '123', groupName: '合成甲群' }));
    expect(open).not.toHaveBeenCalled();
    expect(host.querySelector('[data-presentation="page"]')).not.toBeNull();
    act(() => host.querySelector('button')!.click());
    state.inline = false;
    act(() => controls.open({ kind: 'albums', groupCode: '123', groupName: '合成甲群' }));
    expect(open).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-presentation="page"]')).not.toBeNull();
    act(() => host.querySelector('button')!.click());
    const popup = new HappyWindow();
    const close = vi.spyOn(popup, 'close');
    popups.push(popup);
    open.mockReturnValue(popup as unknown as Window);
    act(() => controls.open({ kind: 'files', groupCode: '456', groupName: '合成乙群' }));
    act(() => root.unmount());
    await act(async () => Promise.resolve());
    expect(close).toHaveBeenCalled();
  } finally {
    if (host.childNodes.length) act(() => root.unmount());
  }
});

it('系统关闭后可重开同群窗口，旧窗口清理不能关闭新窗口，锁定期间不再打开', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Host, { ownerKey: '10001:source-a' })));
    act(() => controls.open({ kind: 'files', groupCode: '123', groupName: '合成甲群' }));
    Object.defineProperty(popups[0], 'closed', { configurable: true, value: true });
    act(() => controls.open({ kind: 'files', groupCode: '123', groupName: '合成甲群' }));
    const second = popups[1]!;
    const close = vi.spyOn(second, 'close');
    await act(async () => Promise.resolve());
    expect(second.document.querySelector('[data-group="123"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    act(() => useAppLock.getState().lock());
    expect(second.document.querySelector('[role="status"]')?.textContent).toBe('应用已锁定');
    act(() => controls.open({ kind: 'albums', groupCode: '456', groupName: '合成乙群' }));
    expect(open).toHaveBeenCalledTimes(2);
    act(() => useAppLock.getState().unlock());
    act(() => controls.open({ kind: 'files', groupCode: '../invalid', groupName: '无效群' }));
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    useAppLock.getState().unlock();
    act(() => root.unmount());
    await Promise.resolve();
  }
});
