import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import { LogPerformanceWindowHost } from '../src/renderer/src/components/LogPerformanceWindow';
import { useLogPerformanceWindow } from '../src/renderer/src/state/logPerformanceWindow';
import { useAppLock } from '../src/renderer/src/state/lock';
import { RenderDocumentContext, useRenderDocument } from '../src/renderer/src/lib/renderDocument';
import { TabActivity, useTabActive } from '../src/renderer/src/components/RetainedTabs';
import { IconPicker } from '../src/renderer/src/components/ui/iconPicker';

vi.mock('../src/renderer/src/components/settings/PerformanceMonitor', () => ({
  default: () =>
    h('input', {
      'aria-label': '合成性能视图',
      'data-active': String(useTabActive()),
      'data-own-document': String(useRenderDocument() !== document),
      defaultValue: '',
    }),
}));
vi.mock('../src/renderer/src/components/settings/LogViewerPanel', () => ({
  LogViewerPanel: () =>
    h('input', {
      'aria-label': '合成日志视图',
      'data-active': String(useTabActive()),
      defaultValue: '',
    }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ ToastHost: () => null }));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useLogPerformanceWindow.getState().dismiss();
  useAppLock.getState().unlock();
});
afterEach(() => {
  useLogPerformanceWindow.getState().dismiss();
  useAppLock.getState().unlock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('两个工具窗使用各自较小尺寸，不接受任意页面', () => {
  expect(applicationToolPopupOptions('about:blank', 'weq-performance-monitor')).toMatchObject({
    title: 'WeQ · 性能监视',
    width: 1060,
    height: 740,
    minWidth: 720,
    minHeight: 520,
    frame: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  expect(applicationToolPopupOptions('about:blank', 'weq-log-viewer')).toMatchObject({
    title: 'WeQ · 日志查看',
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 480,
  });
  expect(applicationToolPopupOptions('https://example.invalid/', 'weq-log-viewer')).toBeNull();
  expect(applicationToolPopupOptions('about:blank', 'weq-log-performance')).toBeNull();
});

it('两个入口各开一个窗口，可同时显示，重复打开保留各自现场，锁定时均停用', async () => {
  const performance = new HappyWindow(),
    logs = new HappyWindow();
  const open = vi
    .spyOn(window, 'open')
    .mockReturnValueOnce(performance as unknown as Window)
    .mockReturnValueOnce(logs as unknown as Window);
  const focus = vi.spyOn(performance, 'focus');
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(h(LogPerformanceWindowHost)));
    await act(async () => useLogPerformanceWindow.getState().open('performance'));
    const input = performance.document.querySelector<HTMLInputElement>(
      '[aria-label="合成性能视图"]',
    )!;
    expect(input.dataset.ownDocument).toBe('true');
    input.value = '保留性能筛选';
    await act(async () => useLogPerformanceWindow.getState().open('logs'));
    const log = logs.document.querySelector<HTMLInputElement>('[aria-label="合成日志视图"]')!;
    log.value = '保留阅读位置';
    expect(input.dataset.active).toBe('true');
    expect(log.dataset.active).toBe('true');
    await act(async () => useLogPerformanceWindow.getState().open('performance'));
    await act(async () => useLogPerformanceWindow.getState().open('logs'));
    expect(open).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalled();
    expect(input.value).toBe('保留性能筛选');
    expect(log.value).toBe('保留阅读位置');
    expect(performance.document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    act(() => useAppLock.getState().lock());
    expect(input.dataset.active).toBe('false');
    expect(log.dataset.active).toBe('false');
    act(() => useLogPerformanceWindow.getState().open('performance'));
    expect(open).toHaveBeenCalledTimes(2);
    act(() => useAppLock.getState().unlock());
    expect(input.dataset.active).toBe('true');
    act(() => useLogPerformanceWindow.getState().dismiss('performance'));
    expect(useLogPerformanceWindow.getState().requests.logs?.popup).toBe(logs);
    expect(log.dataset.active).toBe('true');
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    performance.close();
    logs.close();
  }
});

it('系统关闭后立刻再次打开也会交接到新窗口，不等待旧窗口轮询', async () => {
  const first = new HappyWindow(),
    second = new HappyWindow();
  vi.spyOn(window, 'open')
    .mockReturnValueOnce(first as unknown as Window)
    .mockReturnValueOnce(second as unknown as Window);
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(h(LogPerformanceWindowHost)));
    await act(async () => useLogPerformanceWindow.getState().open('performance'));
    Object.defineProperty(first, 'closed', { configurable: true, value: true });
    await act(async () => useLogPerformanceWindow.getState().open('performance'));
    expect(second.document.querySelector('[aria-label="合成性能视图"]')).not.toBeNull();
    expect(useLogPerformanceWindow.getState().requests.performance?.popup).toBe(second);
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
    first.close();
    second.close();
  }
});

it('不能创建弹窗时使用对应的独立整页，不显示页签切换', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    await act(async () => {
      root.render(h(LogPerformanceWindowHost));
      useLogPerformanceWindow.getState().open('performance');
    });
    expect(host.querySelector('[aria-label="合成性能视图"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
  } finally {
    act(() => root.unmount());
    await Promise.resolve();
  }
});

it('独立窗口的选择菜单留在自己的文档，支持方向键与 Esc，失活后关闭', () => {
  const popup = new HappyWindow();
  const root = createRoot(popup.document.body);
  const change = vi.fn();
  const render = (active: boolean) =>
    act(() =>
      root.render(
        h(
          RenderDocumentContext.Provider,
          { value: popup.document as unknown as Document },
          h(
            TabActivity,
            { active },
            h(IconPicker, {
              ariaLabel: '合成选择',
              value: 'a',
              onChange: change,
              options: [
                { value: 'a', label: '甲' },
                { value: 'b', label: '乙' },
              ],
            }),
          ),
        ),
      ),
    );
  try {
    render(true);
    const trigger = popup.document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"][aria-label="合成选择"]')).toBeNull();
    const list = popup.document.querySelector('[role="listbox"]')!;
    const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    act(() => {
      options[0]!.focus();
      options[0]!.dispatchEvent(
        new popup.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(popup.document.activeElement).toBe(options[1]);
    act(() =>
      options[1]!.dispatchEvent(
        new popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(popup.document.querySelector('[role="listbox"]')).toBeNull();
    expect(popup.document.activeElement).toBe(trigger);
    act(() => trigger.click());
    render(false);
    expect(popup.document.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    popup.close();
  }
});
