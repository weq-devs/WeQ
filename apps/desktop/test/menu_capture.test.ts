import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU_CAPTURE_HOVER_MS, useMenuCapture } from '../src/renderer/src/hooks/useMenuCapture';

let host: HTMLDivElement;
let root: Root;
let capture: ReturnType<typeof vi.fn<() => Promise<void>>>;
let runCapture: () => Promise<void>;

function Fixture() {
  const controls = useMenuCapture(capture);
  runCapture = controls.onClick;
  return createElement(
    'div',
    { className: 'weq-dialog-layer' },
    createElement(
      'section',
      { className: 'weq-workspace-menu' },
      createElement('p', null, '合成菜单'),
      createElement('button', { className: 'weq-menu-capture-button', ...controls }, '截图'),
    ),
  );
}

function layer() {
  return document.querySelector<HTMLElement>('.weq-dialog-layer')!;
}
function button() {
  return layer().querySelector('button')!;
}
function pointer(type: string) {
  act(() => button().dispatchEvent(new PointerEvent(type, { bubbles: true })));
}
async function click() {
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(50);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  capture = vi.fn(async () => {});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Fixture)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('菜单截图', () => {
  it('停留满 1 秒才进入预览，离开立即恢复且不移动按钮', () => {
    const original = button();
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS - 1));
    expect(layer().dataset.menuCapture).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(layer().dataset.menuCapture).toBe('preview');
    expect(button()).toBe(original);
    pointer('pointerout');
    expect(layer().dataset.menuCapture).toBeUndefined();
  });

  it('提前离开取消计时，重新进入重新计时', () => {
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(600));
    pointer('pointerout');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    expect(layer().dataset.menuCapture).toBeUndefined();
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    expect(layer().dataset.menuCapture).toBe('preview');
  });

  it.each([false, true])('截图 IPC 前隐藏菜单和按钮，不要求先悬停：%s', async (hover) => {
    if (hover) {
      pointer('pointerover');
      act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    }
    capture.mockImplementation(async () => {
      expect(layer().dataset.menuCapture).toBe('capturing');
    });
    await click();
    expect(capture).toHaveBeenCalledOnce();
    expect(layer().dataset.menuCapture).toBe(hover ? 'preview' : undefined);
  });

  it('截图期间离开不会提前露出菜单，结束后恢复且不重复截图', async () => {
    let finish!: () => void;
    capture.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    await click();
    pointer('pointerout');
    expect(layer().dataset.menuCapture).toBe('capturing');
    await click();
    expect(capture).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(layer().dataset.menuCapture).toBeUndefined();
  });

  it('截图失败也恢复界面', async () => {
    capture.mockRejectedValue(new Error('合成截图失败'));
    const result = runCapture();
    const rejected = expect(result).rejects.toThrow('合成截图失败');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await rejected;
    expect(capture).toHaveBeenCalledOnce();
    expect(layer().dataset.menuCapture).toBeUndefined();
  });

  it('窗口失焦和卸载清理隐藏状态及待触发计时器', () => {
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    act(() => window.dispatchEvent(new Event('blur')));
    expect(layer().dataset.menuCapture).toBeUndefined();
    pointer('pointerout');
    pointer('pointerover');
    const original = layer();
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    expect(original.dataset.menuCapture).toBeUndefined();
  });

  it('菜单保留挂载时，关闭也取消计时并清除预览状态', async () => {
    pointer('pointerover');
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    await act(async () => {
      layer().hidden = true;
    });
    expect(layer().dataset.menuCapture).toBeUndefined();
    await act(async () => {
      layer().hidden = false;
    });
    pointer('pointerover');
    await act(async () => {
      layer().hidden = true;
    });
    act(() => vi.advanceTimersByTime(MENU_CAPTURE_HOVER_MS));
    expect(layer().dataset.menuCapture).toBeUndefined();
  });
});
