import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { createToolWindowRegistry } from '../src/main/tool_window';
import { focusToolPopup, useToolWindow } from '../src/renderer/src/hooks/useCompositionWindow';
import { useDatabaseBrowserWindow } from '../src/renderer/src/state/databaseBrowserWindow';
import { useLogPerformanceWindow } from '../src/renderer/src/state/logPerformanceWindow';

afterEach(() => {
  useDatabaseBrowserWindow.getState().dismiss();
  useLogPerformanceWindow.getState().dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['weq-database-browser', 'weq-log-viewer', 'weq-performance-monitor'] as const)(
  '%s 的独立状态入口复用原窗并请求原生焦点',
  (name) => {
    const popup = new HappyWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const send = vi.fn();
    vi.stubGlobal('electron', { ipcRenderer: { send } });
    const request = () => {
      if (name === 'weq-database-browser') useDatabaseBrowserWindow.getState().open();
      else
        useLogPerformanceWindow.getState().open(name === 'weq-log-viewer' ? 'logs' : 'performance');
    };
    try {
      request();
      popup.document.body.textContent = '保留查询';
      send.mockClear();
      request();
      expect(open).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith('tool-window:focus', name);
      expect(popup.document.body.textContent).toBe('保留查询');
    } finally {
      popup.close();
    }
  },
);

it('没有窗口或窗口已关闭时不发送焦点请求', () => {
  const popup = new HappyWindow();
  const send = vi.fn();
  vi.stubGlobal('electron', { ipcRenderer: { send } });
  Object.defineProperty(popup, 'closed', { value: true });
  focusToolPopup('weq-compose', null);
  focusToolPopup('weq-compose', popup as unknown as Window);
  expect(send).not.toHaveBeenCalled();
  popup.close();
});

function nativeWindow() {
  let closed = () => {};
  const win = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn((_event: 'closed', listener: () => void) => {
      closed = listener;
    }),
  };
  return { win, close: () => closed() };
}

it('重复打开由主进程恢复最小化原窗，显示后再聚焦，不改窗口内容', () => {
  const registry = createToolWindowRegistry();
  const { win } = nativeWindow();
  registry.register(1, 'weq-compose', win);
  win.isMinimized.mockReturnValue(true);
  expect(registry.focus(1, 'weq-compose')).toBe(true);
  expect(win.restore).toHaveBeenCalledOnce();
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.focus).toHaveBeenCalledOnce();
  expect(win.restore.mock.invocationCallOrder[0]).toBeLessThan(
    win.show.mock.invocationCallOrder[0]!,
  );
  expect(win.show.mock.invocationCallOrder[0]).toBeLessThan(win.focus.mock.invocationCallOrder[0]!);
});

it('已显示的后台原窗仍显示并聚焦，不调用还原', () => {
  const registry = createToolWindowRegistry();
  const { win } = nativeWindow();
  registry.register(1, 'weq-db-repair', win);
  expect(registry.focus(1, 'weq-db-repair')).toBe(true);
  expect(win.restore).not.toHaveBeenCalled();
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.focus).toHaveBeenCalledOnce();
});

it('按父窗口和工具名找目标，不聚焦其他父窗、其他工具或已销毁窗口', () => {
  const registry = createToolWindowRegistry();
  const first = nativeWindow();
  const otherOwner = nativeWindow();
  const otherTool = nativeWindow();
  registry.register(1, 'weq-db-repair', first.win);
  registry.register(2, 'weq-db-repair', otherOwner.win);
  registry.register(1, 'weq-compose', otherTool.win);
  expect(registry.focus(1, 'weq-db-repair')).toBe(true);
  expect(otherOwner.win.focus).not.toHaveBeenCalled();
  expect(otherTool.win.focus).not.toHaveBeenCalled();
  expect(registry.focus(3, 'weq-db-repair')).toBe(false);
  expect(registry.focus(1, 'unknown')).toBe(false);
  expect(registry.focus(1, {})).toBe(false);
  first.win.isDestroyed.mockReturnValue(true);
  expect(registry.focus(1, 'weq-db-repair')).toBe(false);
  expect(first.win.focus).toHaveBeenCalledOnce();
});

it('关窗移除登记，旧窗口迟到关闭不删除替代窗口，父窗关闭清理所属登记', () => {
  const registry = createToolWindowRegistry();
  const first = nativeWindow();
  const replacement = nativeWindow();
  registry.register(1, 'weq-db-repair', first.win);
  registry.register(1, 'weq-db-repair', replacement.win);
  first.close();
  expect(registry.focus(1, 'weq-db-repair')).toBe(true);
  expect(replacement.win.focus).toHaveBeenCalledOnce();
  replacement.close();
  expect(registry.focus(1, 'weq-db-repair')).toBe(false);
  registry.register(1, 'weq-compose', first.win);
  registry.clear(1);
  expect(registry.focus(1, 'weq-compose')).toBe(false);
});

it.each([true, false])('复用工具窗口保留文档，原生桥接可用=%s', async (native) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const webFocus = vi.spyOn(popup, 'focus');
  const send = vi.fn();
  vi.stubGlobal('electron', native ? { ipcRenderer: { send } } : undefined);
  let tool: ReturnType<typeof useToolWindow>;
  function Host() {
    tool = useToolWindow({
      name: 'weq-compose',
      title: 'WeQ · 合成聊天记录',
      width: 1000,
      height: 680,
      bodyClass: 'weq-composition-window-body',
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    act(() => root.render(h(Host)));
    act(() => tool.open());
    popup.document.body.textContent = '保留草稿';
    act(() => tool.open());
    expect(open).toHaveBeenCalledOnce();
    expect(popup.document.body.textContent).toBe('保留草稿');
    if (native) {
      expect(send).toHaveBeenCalledWith('tool-window:focus', 'weq-compose');
      expect(webFocus).not.toHaveBeenCalled();
    } else {
      expect(send).not.toHaveBeenCalled();
      expect(webFocus).toHaveBeenCalledOnce();
    }
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    popup.close();
  }
});
