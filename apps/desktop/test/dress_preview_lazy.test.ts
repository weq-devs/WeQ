import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DressUpDialog } from '../src/renderer/src/components/DressUpDialog';
import { PLAYBACK_LIMIT } from '../src/renderer/src/hooks/useVideoPlaybackSlot';

/**
 * 通话背景列表的预览加载策略。
 *
 * 回归的是「一进页就把 82 款视频全挂上去」:整页几十路 mp4 同时解码,打开就卡死。
 * 现在要求:未进视口不设 `src`、进视口也只放行有限路数。
 */

const callBgItems = Array.from({ length: 30 }, (_, i) => {
  const itemId = 50000 + i;
  return {
    appId: 17,
    itemId,
    name: `通话背景 ${itemId}`,
    previewUrl: `https://tianquan.gtimg.cn/funCall/item/${itemId}/image.jpg`,
    previewLargeUrl: '',
    videoUrl: `https://tianquan.gtimg.cn/funCall/item/${itemId}/media.mp4`,
    labels: [],
    price: 0,
    mallName: '',
  };
});

vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    policy: { mode: 'before', directory: '/fixture/export' },
    settings: { isLoading: false },
    picking: false,
    accountUin: '10001',
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    isCurrent: () => true,
    prepareSave: async () => ({ mode: 'before', directory: '/fixture/export' }),
  }),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { dressup: { getState: { invalidate: async () => {} } } } }),
    account: {
      dressup: {
        getState: {
          useQuery: () => ({
            data: {
              qqOnline: false,
              manifest: null,
              own: { callBgId: 0, callBgUrl: '', callBgVideoUrl: '' },
            },
          }),
        },
        rank: { useQuery: () => ({ data: { items: callBgItems, source: 'static' } }) },
        search: { useQuery: () => ({ data: { items: [] } }) },
        widgets: { useQuery: () => ({ data: [] }) },
        ...Object.fromEntries(
          [
            'installBubble',
            'installFont',
            'installWidget',
            'setActive',
            'setScope',
            'pickBackground',
            'setBackground',
            'setWidget',
            'setCallBackground',
            'setBackgroundOpacity',
          ].map((name) => [name, { useMutation: () => ({}) }]),
        ),
      },
    },
  },
}));

type Observer = { callback: IntersectionObserverCallback; elements: Element[] };
let observers: Observer[] = [];

/** 把某张卡片的预览格标记成「已进入视口」。 */
function enterCard(card: Element): void {
  const preview = card.querySelector('.weq-dress-card-preview')!;
  const observer = observers.find((o) => o.elements.includes(preview));
  expect(observer).toBeDefined();
  act(() =>
    observer!.callback(
      [{ isIntersecting: true, target: preview } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
}

function cardOf(host: HTMLElement, itemId: number): Element {
  const card = [...host.querySelectorAll('.weq-dress-card')].find((node) =>
    node.textContent?.includes(`通话背景 ${itemId}`),
  );
  expect(card).toBeDefined();
  return card!;
}

afterEach(() => {
  observers = [];
  vi.unstubAllGlobals();
});

it('通话背景未进视口不挂视频，进视口后受并发名额限制', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      callback: IntersectionObserverCallback;
      elements: Element[] = [];
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(element: Element) {
        this.elements.push(element);
      }
      disconnect() {}
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(DressUpDialog, { initialKind: 'callbg', onClose: () => {} })),
    );

    // 首屏:一张图都不该请求(全是占位块),更不该有任何 <video>。
    expect(host.querySelectorAll('.weq-dress-card-preview img')).toHaveLength(0);
    expect(host.querySelectorAll('.weq-dress-card-preview video')).toHaveLength(0);
    expect(host.querySelectorAll('.weq-dress-card-pending')).toHaveLength(callBgItems.length);

    // 全部卡片都进视口 —— 也只有名额内的那几路会真的播。
    for (const item of callBgItems) enterCard(cardOf(host, item.itemId));
    expect(host.querySelectorAll('.weq-dress-card-preview video')).toHaveLength(PLAYBACK_LIMIT);

    // 没抢到名额的卡片退回封面图,不是空白。
    const idle = cardOf(host, callBgItems.at(-1)!.itemId);
    expect(idle.querySelector('.weq-dress-card-preview img')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
