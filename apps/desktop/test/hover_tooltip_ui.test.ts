import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HoverTooltip } from '../src/renderer/src/components/HoverTooltip';
import { Window as HappyWindow } from 'happy-dom';
import { RenderDocumentContext } from '../src/renderer/src/lib/renderDocument';
import { CompositionButton } from '../src/renderer/src/components/mergeForward/CompositionButton';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';

afterEach(() => {
  useRestrictedMode.setState({ reasons: [], requests: [], open: false });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])(
  '单按 %s 不取消等待或关闭提示，组合键仍关闭并恢复标题',
  async (key) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const host = document.createElement('div');
    const button = document.createElement('button');
    button.title = '保存备注';
    document.body.append(host, button);
    const root = createRoot(host);
    const press = (key: string, init: KeyboardEventInit = {}) =>
      act(() =>
        button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...init })),
      );
    try {
      act(() => root.render(createElement(HoverTooltip)));
      act(() => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
      press(key);
      await act(async () => vi.advanceTimersByTime(300));
      const tooltip = document.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toBe('保存备注');
      press(key);
      expect(document.querySelector('[role="tooltip"]')).toBe(tooltip);
      expect(button.getAttribute('aria-describedby')).toContain('weq-hover-tooltip');
      press('c', { ctrlKey: true });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      expect(button.title).toBe('保存备注');
      expect(button.hasAttribute('aria-describedby')).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      button.remove();
    }
  },
);

it('受限 QQ 控件显示操作限制，不改写可用操作与其它禁用控件的提示', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  useRestrictedMode.setState({
    reasons: [{ code: 'offline', title: 'QQ 不在线', guidance: '登录 QQ' }],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(HoverTooltip)));
    for (const [qq, disabled, expected] of [
      [true, true, '受限模式下无法保存备注'],
      [true, false, '保存备注'],
      [false, true, '保存备注'],
    ] as const) {
      const button = document.createElement('button');
      button.title = '保存备注';
      button.disabled = disabled;
      if (qq) button.setAttribute('data-qq-action', '');
      host.append(button);
      await act(async () => {
        button.dispatchEvent(
          new PointerEvent('pointerover', { bubbles: true, clientX: 20, clientY: 30 }),
        );
        vi.advanceTimersByTime(300);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(expected);
      act(() => button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
      button.remove();
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('独立合成文档中禁用按钮显示具体原因，提示不落在主窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const child = new HappyWindow();
  const owner = child.document as unknown as Document;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          RenderDocumentContext.Provider,
          { value: owner },
          createElement(HoverTooltip),
        ),
      ),
    );
    const button = owner.createElement('button');
    button.disabled = true;
    button.title = '合并转发：QQ 未在线';
    owner.body.append(button);
    await act(async () => {
      button.dispatchEvent(
        new child.PointerEvent('pointerover', {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        }) as unknown as Event,
      );
      vi.advanceTimersByTime(300);
    });
    expect(owner.querySelector('[role="tooltip"]')?.textContent).toBe('合并转发：QQ 未在线');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => root.unmount());
    expect(button.title).toBe('合并转发：QQ 未在线');
  } finally {
    act(() => root.unmount());
    host.remove();
    await child.happyDOM.close();
  }
});

it('合成按钮保留原生禁用和 ref，文字按钮自动具备动作提示', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = { current: null as HTMLButtonElement | null };
  try {
    act(() =>
      root.render(
        createElement(
          CompositionButton,
          { ref, disabled: true, disabledReason: '已经是第一项' },
          '上移',
        ),
      ),
    );
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.title).toBe('上移：已经是第一项');
    expect(ref.current?.dataset.disabledReason).toBe('已经是第一项');
    act(() => root.render(createElement(CompositionButton, { ref }, '保存')));
    expect(ref.current?.title).toBe('保存');
    expect(ref.current?.dataset.disabledReason).toBeUndefined();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('提示框按内容确定宽度，边框和内边距计入窗口宽度上限', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(
    resolve(__dirname, '../src/renderer/src/styles/hover-tooltip.css'),
    'utf8',
  );
  const bubble = document.createElement('div');
  bubble.className = 'weq-hover-tooltip';
  document.head.append(style);
  document.body.append(bubble);
  try {
    const computed = getComputedStyle(bubble);
    expect(computed.width).toBe('max-content');
    expect(computed.boxSizing).toBe('border-box');
  } finally {
    bubble.remove();
    style.remove();
  }
});

it('靠近右下角时按完整提示尺寸向左、向上避让', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 240, 46),
  );
  const host = document.createElement('div');
  const button = document.createElement('button');
  button.title = '发送正在输入状态（已开启）';
  document.body.append(host, button);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(HoverTooltip)));
    await act(async () => {
      button.dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          clientX: window.innerWidth - 10,
          clientY: window.innerHeight - 20,
        }),
      );
      vi.advanceTimersByTime(300);
    });
    const bubble = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(bubble.textContent).toBe(button.getAttribute('aria-label'));
    expect(bubble.style.left).toBe(`${window.innerWidth - 240 - 8}px`);
    expect(Number.parseFloat(bubble.style.top) + 46).toBeLessThan(window.innerHeight);
  } finally {
    act(() => root.unmount());
    host.remove();
    button.remove();
  }
});
