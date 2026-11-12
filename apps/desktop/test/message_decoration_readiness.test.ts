import { act, createElement, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FontFx } from '@weq/service';
import { useMsgDecoration } from '../src/renderer/src/hooks/useMsgDecoration';
import { MsgDecorationEnabledContext } from '../src/renderer/src/components/QqMessageContent';
import { decorationImageCache } from '../src/renderer/src/lib/decodedImageCache';
import { fontFaces } from '../src/renderer/src/lib/fontFaces';

const fixture = vi.hoisted(() => ({
  bubble: {
    itemId: 21009,
    slice: { left: 4, right: 4, top: 4, bottom: 4 },
    imageSize: { w: 40, h: 40 },
    textColor: '#516196',
  },
  font: { itemId: 31009, deriveVersion: 1, fx: null as FontFx | null },
  bubbleAvailable: true,
  fontAvailable: true,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      dressup: {
        resolveMsgDecoration: {
          useQuery: (ids: { bubbleId: number; fontId: number }) => ({
            data: {
              bubble: ids.bubbleId && fixture.bubbleAvailable ? fixture.bubble : null,
              font: ids.fontId && fixture.fontAvailable ? fixture.font : null,
            },
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqMessageContent', async () => {
  const { createContext } = await import('react');
  return { MsgDecorationEnabledContext: createContext({ bubble: true, font: true, widget: true }) };
});

let imageReady: () => void;
let imageFailed: () => void;
let fontReady: () => void;
let fontFailed: () => void;
let imageLoads = 0;
let fontLoads = 0;
beforeEach(() => {
  imageLoads = fontLoads = 0;
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
  fixture.bubbleAvailable = fixture.fontAvailable = true;
  fixture.font.fx = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 40;
      naturalHeight = 40;
      removeAttribute() {
        this.src = '';
      }
      decode() {
        imageLoads++;
        return new Promise<void>((resolve, reject) => {
          imageReady = resolve;
          imageFailed = () => reject(new Error('底图下载失败'));
        });
      }
    },
  );
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        fontLoads++;
        return new Promise((resolve, reject) => {
          fontReady = () => resolve(this);
          fontFailed = () => reject(new Error('字体解码失败'));
        });
      }
    },
  );
});
afterEach(() => {
  fontFaces.clearIdle();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

function probe(observe = false) {
  const host = document.createElement('div');
  const root = createRoot(host);
  let closed = false;
  const commits: number[] = [];
  function Message({ bubbleId, fontId }: { bubbleId: number; fontId: number }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const decoration = useMsgDecoration(
      { bubbleId, fontId, widgetId: 0 },
      observe ? ref : undefined,
    );
    useLayoutEffect(() => {
      commits.push(decoration.fontId);
    });
    return createElement('div', {
      ref,
      'data-bubble': decoration.bubbleId,
      'data-font': decoration.fontId,
      'data-fontfx': decoration.fontFx ? 'active' : '',
    });
  }
  return {
    commits,
    render: (
      bubbleId = 21009,
      fontId = 31009,
      enabled = { bubble: true, font: true, widget: true },
    ) =>
      act(async () =>
        root.render(
          createElement(
            MsgDecorationEnabledContext.Provider,
            { value: enabled },
            createElement(Message, { bubbleId, fontId }),
          ),
        ),
      ),
    expectIds(bubble: number, font: number) {
      expect(host.firstElementChild?.getAttribute('data-bubble')).toBe(String(bubble));
      expect(host.firstElementChild?.getAttribute('data-font')).toBe(String(font));
    },
    close: () =>
      act(async () => {
        if (closed) return;
        closed = true;
        root.unmount();
      }),
  };
}

it.each(['font-first', 'bubble-first'])('本地气泡同步应用，字体注册独立完成：%s', async (order) => {
  const view = probe();
  try {
    await view.render();
    view.expectIds(21009, 0);
    await act(async () => (order === 'font-first' ? fontReady() : imageReady()));
    view.expectIds(21009, order === 'font-first' ? 31009 : 0);
    await act(async () => (order === 'font-first' ? imageReady() : fontReady()));
    view.expectIds(21009, 31009);
  } finally {
    await view.close();
  }
});

it.each(['font', 'bubble'])('字体失败保留气泡，底图失败时不应用字体：%s', async (failed) => {
  const view = probe();
  try {
    await view.render();
    await act(async () => {
      if (failed === 'font') {
        imageReady();
        fontFailed();
      } else {
        imageFailed();
        fontReady();
      }
    });
    view.expectIds(failed === 'font' ? 21009 : 0, 0);
  } finally {
    await view.close();
  }
});

it.each(['font', 'bubble'])('配置未返回不提前应用另一种：%s', async (missing) => {
  fixture.fontAvailable = missing !== 'font';
  fixture.bubbleAvailable = missing !== 'bubble';
  const view = probe();
  try {
    await view.render();
    view.expectIds(missing === 'bubble' ? 0 : 21009, 0);
    fixture.fontAvailable = fixture.bubbleAvailable = true;
    await view.render();
    await act(async () => {
      imageReady();
      fontReady();
    });
    view.expectIds(21009, 31009);
  } finally {
    await view.close();
  }
});

it.each(['font', 'bubble'])('只有一种装扮时独立就绪：%s', async (kind) => {
  const view = probe();
  try {
    await view.render(kind === 'bubble' ? 21009 : 0, kind === 'font' ? 31009 : 0);
    view.expectIds(kind === 'bubble' ? 21009 : 0, 0);
    await act(async () => (kind === 'font' ? fontReady() : imageReady()));
    view.expectIds(kind === 'bubble' ? 21009 : 0, kind === 'font' ? 31009 : 0);
  } finally {
    await view.close();
  }
});

it('主动关闭气泡后字体可单独显示，旧加载完成不恢复已关闭装扮', async () => {
  const view = probe();
  try {
    await view.render();
    const oldImageReady = imageReady;
    await view.render(21009, 31009, { bubble: false, font: true, widget: true });
    await act(async () => {
      fontReady();
      oldImageReady();
    });
    view.expectIds(0, 31009);
  } finally {
    await view.close();
  }
});

it('同款消息共享预热，一条卸载不撤销其他消息，全部卸载后释放资源', async () => {
  const first = probe();
  const second = probe();
  try {
    await first.render();
    await second.render();
    expect(imageLoads).toBe(1);
    expect(fontLoads).toBe(1);
    await act(async () => {
      imageReady();
      fontReady();
    });
    first.expectIds(21009, 31009);
    second.expectIds(21009, 31009);
    await first.close();
    second.expectIds(21009, 31009);
    expect(decorationImageCache.stats().pinnedImages).toBe(1);
    expect(fontFaces.count()).toBe(1);
  } finally {
    await first.close();
    await second.close();
  }
  expect(decorationImageCache.stats().pinnedImages).toBe(0);
  expect(fontFaces.count()).toBe(0);
});

it('同款历史行首次提交即复用已就绪字体，不等待可见性通知', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const first = probe();
  const history = probe(true);
  try {
    await first.render(0, 31019);
    await act(async () => fontReady());
    await history.render(0, 31019);
    expect(history.commits[0]).toBe(31019);
    history.expectIds(0, 31019);
    expect(fontLoads).toBe(1);
  } finally {
    await first.close();
    await history.close();
  }
});

it('虚拟行全部卸载后返回同步复用解码结果，资源版本变化仍重新加载', async () => {
  const first = probe();
  const history = probe();
  try {
    await first.render(0, 31029);
    await act(async () => fontReady());
    await first.close();
    expect(fontFaces.count()).toBe(0);
    await history.render(0, 31029);
    expect(history.commits[0]).toBe(31029);
    expect(fontLoads).toBe(1);
    fixture.font = { ...fixture.font, deriveVersion: 2 };
    await history.render(0, 31029);
    history.expectIds(0, 0);
    expect(fontLoads).toBe(2);
    await act(async () => fontReady());
    history.expectIds(0, 31029);
  } finally {
    fixture.font = { ...fixture.font, deriveVersion: 1 };
    await first.close();
    await history.close();
  }
});

it('不可见冷字体不加载；进入后加载，离开再返回不撤销字体或闪回默认', async () => {
  let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof visibility) {
        visibility = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const view = probe(true);
  try {
    await view.render(0, 31039);
    expect(fontLoads).toBe(0);
    view.expectIds(0, 0);
    await act(async () => visibility([{ isIntersecting: true }]));
    expect(fontLoads).toBe(1);
    await act(async () => fontReady());
    const start = view.commits.length;
    await act(async () => visibility([{ isIntersecting: false }]));
    await act(async () => visibility([{ isIntersecting: true }]));
    expect(view.commits.slice(start)).not.toContain(0);
    expect(fontLoads).toBe(1);
    expect(document.fonts.delete).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('缓存字体离屏仍显示，但炫彩帧及时释放，关闭字体设置会移除全部样式', async () => {
  let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof visibility) {
        visibility = callback;
      }
      observe() {
        visibility([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  fixture.font.fx = { variants: [{ width: 40, height: 40, frames: [1] }] };
  const view = probe(true);
  try {
    await view.render(0, 31009);
    await act(async () => {
      fontReady();
      imageReady();
    });
    expect(decorationImageCache.stats().pinnedImages).toBe(1);
    await act(async () => visibility([{ isIntersecting: false }]));
    view.expectIds(0, 31009);
    expect(decorationImageCache.stats().pinnedImages).toBe(0);
    await view.render(0, 31009, { bubble: true, font: false, widget: true });
    view.expectIds(0, 0);
    expect(fontFaces.count()).toBe(0);
    expect(document.querySelector('[data-weq-msg-decoration]')).toBeNull();
  } finally {
    await view.close();
  }
});
