import { afterEach, expect, it, vi } from 'vitest';
import {
  isConversationPagingVisible,
  observeConversationPaging,
} from '../src/renderer/src/lib/conversationPaging';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fixture() {
  const parent = document.createElement('div');
  const scroll = document.createElement('div');
  parent.append(scroll);
  document.body.append(parent);
  let height = 300;
  Object.defineProperties(scroll, {
    clientHeight: { get: () => height },
    clientWidth: { get: () => 600 },
    scrollHeight: { get: () => 1500 },
  });
  const rect = new DOMRect(0, 0, 600, 300);
  const rects = Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  vi.spyOn(scroll, 'getClientRects').mockReturnValue(rects);
  scroll.scrollTop = 600;
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    frames.delete(id);
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return {
    parent,
    scroll,
    flush,
    frames,
    resize: () => resize(),
    disconnect,
    setHeight: (value: number) => {
      height = value;
    },
  };
}

it('零尺寸、hidden、inert、脱离文档或隐藏窗口均不能翻页', () => {
  const f = fixture();
  expect(isConversationPagingVisible(f.scroll)).toBe(true);
  f.setHeight(0);
  expect(isConversationPagingVisible(f.scroll)).toBe(false);
  f.setHeight(300);
  vi.mocked(f.scroll.getClientRects).mockReturnValueOnce(Object.assign([], { item: () => null }));
  expect(isConversationPagingVisible(f.scroll)).toBe(false);
  for (const attribute of ['hidden', 'inert']) {
    f.parent.setAttribute(attribute, '');
    expect(isConversationPagingVisible(f.scroll)).toBe(false);
    f.parent.removeAttribute(attribute);
  }
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    expect(isConversationPagingVisible(f.scroll)).toBe(false);
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
  f.scroll.remove();
  expect(isConversationPagingVisible(f.scroll)).toBe(false);
});

it('可见时保留顶部、底部和短页的原翻页行为，中部不请求', () => {
  const f = fixture();
  const older = vi.fn(),
    newer = vi.fn();
  const stop = observeConversationPaging(f.scroll, older, newer);
  f.flush();
  expect(older).not.toHaveBeenCalled();
  expect(newer).not.toHaveBeenCalled();
  f.scroll.scrollTop = 40;
  f.scroll.dispatchEvent(new Event('scroll'));
  f.flush();
  expect(older).toHaveBeenCalledWith(f.scroll);
  expect(newer).not.toHaveBeenCalled();
  f.scroll.scrollTop = 1190;
  f.scroll.dispatchEvent(new Event('scroll'));
  f.flush();
  expect(newer).toHaveBeenCalledWith(f.scroll);
  older.mockClear();
  newer.mockClear();
  f.setHeight(1600);
  f.scroll.scrollTop = 0;
  f.resize();
  f.flush();
  expect(older).toHaveBeenCalledOnce();
  expect(newer).toHaveBeenCalledOnce();
  stop();
});

it('排队检查执行前隐藏或重复触发尺寸通知，不会请求；返回后自动恢复', () => {
  const f = fixture();
  f.scroll.scrollTop = 0;
  const older = vi.fn(),
    newer = vi.fn();
  const stop = observeConversationPaging(f.scroll, older, newer);
  f.parent.hidden = true;
  f.setHeight(0);
  f.flush();
  for (let index = 0; index < 10; index++) {
    f.resize();
    f.flush();
  }
  expect(older).not.toHaveBeenCalled();
  expect(newer).not.toHaveBeenCalled();
  f.parent.hidden = false;
  f.setHeight(300);
  f.resize();
  f.flush();
  expect(older).toHaveBeenCalledOnce();
  stop();
});

it('页面重新可见触发检查，停止后清除观察器、监听与待执行帧', () => {
  const f = fixture();
  const older = vi.fn();
  const stop = observeConversationPaging(f.scroll, older, vi.fn());
  f.flush();
  f.scroll.scrollTop = 0;
  document.dispatchEvent(new Event('visibilitychange'));
  f.flush();
  expect(older).toHaveBeenCalledOnce();
  f.resize();
  expect(f.frames.size).toBe(1);
  stop();
  expect(f.frames.size).toBe(0);
  expect(f.disconnect).toHaveBeenCalledOnce();
  f.resize();
  f.scroll.dispatchEvent(new Event('scroll'));
  document.dispatchEvent(new Event('visibilitychange'));
  f.flush();
  expect(older).toHaveBeenCalledOnce();
});
