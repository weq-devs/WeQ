import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  font: { deriveVersion: 1, fx: null },
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

function probe() {
  const host = document.createElement('div');
  const root = createRoot(host);
  let closed = false;
  function Message({ bubbleId, fontId }: { bubbleId: number; fontId: number }) {
    const decoration = useMsgDecoration({ bubbleId, fontId, widgetId: 0 });
    return createElement('div', {
      'data-bubble': decoration.bubbleId,
      'data-font': decoration.fontId,
      'data-fontfx': decoration.fontFx ? 'active' : '',
    });
  }
  return {
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

it.each(['font-first', 'bubble-first'])('双装扮等实际资源一起就绪：%s', async (order) => {
  const view = probe();
  try {
    await view.render();
    view.expectIds(0, 0);
    await act(async () => (order === 'font-first' ? fontReady() : imageReady()));
    view.expectIds(0, 0);
    await act(async () => (order === 'font-first' ? imageReady() : fontReady()));
    view.expectIds(21009, 31009);
  } finally {
    await view.close();
  }
});

it.each(['font', 'bubble'])('任一资源失败保持整组默认：%s', async (failed) => {
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
    view.expectIds(0, 0);
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
    view.expectIds(0, 0);
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
    view.expectIds(0, 0);
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
