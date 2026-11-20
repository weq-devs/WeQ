import { act, createElement as h, StrictMode } from 'react';
vi.mock('../src/renderer/src/hooks/useDevelopmentDressTools', () => ({
  useDevelopmentDressTools: () => true,
}));
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaPreview, type PreviewMedia } from '../src/renderer/src/components/MediaPreview';
import { mergePreviewMedia } from '../src/renderer/src/components/MediaPreview.shared';
import { ChatMediaGallery } from '../src/renderer/src/components/ChatMediaGallery';
import { galleryMedia } from '../src/renderer/src/components/ChatMediaGallery.shared';
import { QqMessageContent } from '../src/renderer/src/components/QqMessageContent';
import { MarketFaceLightbox } from '../src/renderer/src/components/MarketFaceLightbox';
import { openMarketFaceLightbox } from '../src/renderer/src/state/marketFaceLightbox';
import { MediaPreviewHost } from '../src/renderer/src/components/mediaPreviewStore';
import { openMediaPreview } from '../src/renderer/src/components/mediaPreviewStore.shared';
import { QqMarketFace } from '../src/renderer/src/components/QqMedia';
import { useDataSaver } from '../src/renderer/src/lib/dataSaver';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import {
  TransferActivity,
  TransferActivityContext,
} from '../src/renderer/src/lib/transferActivity';
import { useViewState } from '../src/renderer/src/state/view';

const mocks = vi.hoisted(() => ({
  ocr: vi.fn(),
  page: vi.fn(),
  bound: false,
  configId: 'fixture-a',
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: mocks.bound
      ? { expectedAccountUin: '10001', expectedAccountConfigId: mocks.configId }
      : null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { mediaPreviewPage: { query: mocks.page } } },
  trpc: {
    useUtils: () => ({}),
    account: {
      getGroupAlbumAccessState: { useQuery: () => ({ data: { ocrLocalModelId: 'fixture' } }) },
      ocrCacheLookup: { useQuery: () => ({ data: undefined }) },
      ocrChatImage: { useMutation: () => ({ mutateAsync: mocks.ocr }) },
      marketEmoji: {
        getPackDetail: {
          useQuery: () => ({
            data: {
              name: '合成表情包',
              feeType: 'free',
              count: 1,
              items: [{ hash: 'fixture', name: '合成表情' }],
            },
          }),
        },
        getPackKey: { useQuery: () => ({ data: { key: 'fixture-key' } }) },
      },
    },
  },
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  mocks.bound = false;
  mocks.configId = 'fixture-a';
  mocks.page.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function usePrefetchClock() {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('requestIdleCallback', undefined);
  return () => act(async () => vi.advanceTimersByTimeAsync(400));
}
const items: PreviewMedia[] = [
  { key: 'a', src: 'data:image/png;base64,a', kind: 'image', title: '图片A' },
  { key: 'b', src: 'data:video/webm;base64,b', kind: 'video', title: '视频B' },
  { key: 'c', src: 'data:image/png;base64,c', kind: 'image', title: '图片C' },
];
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const key = (name: string) =>
  act(() =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })),
  );
const load = () => act(() => document.querySelector('img')!.dispatchEvent(new Event('load')));
it('聊天灯箱命中本地原图时不显示下载，缺失时可从缩略图查看原图并重试', async () => {
  const pic = { type: 'pic', data: { fileToken: 'fixture', fileSize: 197453 } };
  const chat = galleryMedia([{ msgId: '4', sendTime: 1, elements: [pic, pic] }]);
  act(() => root.render(h(MediaPreview, { items: chat, onClose: vi.fn() })));
  const request = () => new URL(document.querySelector('img')!.src).searchParams;
  const fail = () => act(() => document.querySelector('img')!.dispatchEvent(new Event('error')));
  const viewOriginal = () =>
    [...document.querySelectorAll('button')].find((item) =>
      /(?:查看|重试)原图/.test(item.textContent ?? ''),
    );
  expect(request().get('localOnly')).toBe('1');
  load();
  expect(viewOriginal()).toBeUndefined();
  act(() => button('下一项媒体').click());
  fail();
  load();
  expect(request().get('preview')).toBe('1');
  expect(viewOriginal()?.textContent).toBe('查看原图（0.19 MiB）');
  act(() => viewOriginal()!.click());
  const pending = () => document.querySelectorAll('img')[1]!;
  expect(new URL(pending().src).searchParams.get('v')).toBe('original');
  expect(new URL(pending().src).searchParams.has('localOnly')).toBe(false);
  expect(request().get('preview')).toBe('1');
  const unreadable = pending();
  unreadable.decode = async () => {
    throw new Error('test decode error');
  };
  await act(async () => unreadable.dispatchEvent(new Event('load')));
  expect(request().get('preview')).toBe('1');
  act(() => viewOriginal()!.click());
  const original = pending();
  original.decode = async () => {};
  await act(async () => original.dispatchEvent(new Event('load')));
  expect(document.querySelector('img')).toBe(original);
  expect(request().get('v')).toBe('original');
  expect(viewOriginal()).toBeUndefined();
});
it('自动原图遵循省流量，显示字节进度并等到解码成功才替换缩略图', async () => {
  const previous = useDataSaver.getState().enabled;
  const transfers = new TransferActivity();
  const chat = galleryMedia([
    { msgId: '4', sendTime: 1, elements: [{ type: 'pic', data: { fileToken: 'fixture' } }] },
  ]);
  try {
    act(() => {
      acceptPreferences(
        { revision: 1, values: { autoDownloadPreviewOriginal: true }, records: {} },
        false,
      );
      useDataSaver.setState({ enabled: true });
      root.render(
        h(
          TransferActivityContext.Provider,
          { value: transfers },
          h(MediaPreview, { items: chat, onClose: vi.fn() }),
        ),
      );
    });
    act(() => document.querySelector('img')!.dispatchEvent(new Event('error')));
    load();
    const thumbnail = document.querySelector('img')!;
    expect(document.querySelectorAll('img')).toHaveLength(1);
    act(() => useDataSaver.setState({ enabled: false }));
    const original = document.querySelectorAll('img')[1]!;
    const params = new URL(original.src).searchParams;
    expect(params.get('autoOriginal')).toBe('1');
    act(() =>
      transfers.replace([
        {
          id: params.get('transferId')!,
          direction: 'download',
          phase: 'download',
          received: 25,
          total: 100,
        },
      ]),
    );
    expect(
      document.querySelector('[aria-label="正在下载原图"]')?.getAttribute('aria-valuenow'),
    ).toBe('25');
    const decoding = Promise.withResolvers<void>();
    original.decode = () => decoding.promise;
    act(() => original.dispatchEvent(new Event('load')));
    expect(document.querySelector('img')).toBe(thumbnail);
    expect(document.querySelector('[aria-label="正在解码原图"]')).not.toBeNull();
    await act(async () => decoding.resolve());
    expect(document.querySelector('img')).toBe(original);
  } finally {
    act(() => {
      acceptPreferences({ revision: 2, values: {}, records: {} }, false);
      useDataSaver.setState({ enabled: previous });
    });
  }
});
it('图片视频混排，切项后旧事件失效，视频离开时停止播放', () => {
  act(() => root.render(h(MediaPreview, { items, onClose: vi.fn() })));
  load();
  const old = document.querySelector('img')!;
  key('ArrowRight');
  expect(document.querySelector('video')?.src).toBe(items[1]!.src);
  act(() => old.dispatchEvent(new Event('load')));
  expect(document.querySelector('[data-media-state]')?.getAttribute('data-media-state')).toBe(
    'loading',
  );
  const video = document.querySelector('video')!;
  key('ArrowRight');
  expect(video.pause).toHaveBeenCalled();
  expect(document.querySelector('img')?.src).toBe(items[2]!.src);
});
it('放大后方向键只平移，空白按左右切项且边界不关闭', () => {
  const close = vi.fn();
  act(() => root.render(h(MediaPreview, { items, onClose: close })));
  load();
  act(() => button('放大').click());
  key('ArrowRight');
  expect(document.querySelector('img')?.src).toBe(items[0]!.src);
  expect(document.querySelector<HTMLElement>('.weq-lightbox-frame')!.style.transform).toContain(
    '-40px',
  );
  act(() =>
    document
      .querySelector('.weq-preview-viewport')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: -10 })),
  );
  expect(close).not.toHaveBeenCalled();
  act(() => button('下一项媒体').click());
  expect(document.querySelector('video')).not.toBeNull();
});
it('历史补页和新媒体追加不抢当前项，同URL不同消息仍为独立项目', async () => {
  const page = vi.fn(async () => ({ items: [{ ...items[0]!, key: 'older' }], hasMore: false }));
  await act(async () =>
    root.render(
      h(MediaPreview, { items: [items[0]!], hasOlder: true, loadPage: page, onClose: vi.fn() }),
    ),
  );
  await act(async () => button('上一项媒体').click());
  expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 2');
  await act(async () =>
    root.render(
      h(MediaPreview, {
        items: [items[0]!, items[1]!],
        hasOlder: true,
        loadPage: page,
        onClose: vi.fn(),
      }),
    ),
  );
  expect(document.querySelector('img')?.src).toBe(items[0]!.src);
  expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
  expect(mergePreviewMedia([items[0]!], [{ ...items[0]!, key: 'another' }])).toHaveLength(2);
});
it('稀疏空页继续前进，分页错误可以原地重试', async () => {
  const page = vi
    .fn()
    .mockResolvedValueOnce({ items: [], hasMore: true })
    .mockRejectedValueOnce(new Error('fixture'))
    .mockResolvedValueOnce({ items: [items[1]!], hasMore: false });
  await act(async () =>
    root.render(
      h(MediaPreview, { items: [items[0]!], hasNewer: true, loadPage: page, onClose: vi.fn() }),
    ),
  );
  await act(async () => button('下一项媒体').click());
  expect(button('下一项媒体').disabled).toBe(false);
  await act(async () => button('下一项媒体').click());
  const retry = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('加载失败'),
  )!;
  await act(async () => retry.click());
  expect(document.querySelector('video')).not.toBeNull();
  expect(page).toHaveBeenCalledTimes(3);
});
it('聊天首尾在点击前置灰，后台越过空媒体页且不切换当前项', async () => {
  const idle = usePrefetchClock();
  let finish!: (value: { items: PreviewMedia[]; hasMore: boolean }) => void;
  const page = vi.fn((direction: 'older' | 'newer') =>
    direction === 'older'
      ? Promise.resolve({ items: [], hasMore: false })
      : new Promise<{ items: PreviewMedia[]; hasMore: boolean }>((resolve) => {
          finish = resolve;
        }),
  );
  await act(async () =>
    root.render(
      h(MediaPreview, {
        items: [items[0]!],
        hasOlder: true,
        hasNewer: true,
        prefetchAdjacent: true,
        loadPage: page,
        onClose: vi.fn(),
      }),
    ),
  );
  expect(button('上一项媒体').disabled).toBe(true);
  expect(button('下一项媒体').disabled).toBe(true);
  expect(document.querySelector('img')?.src).toBe(items[0]!.src);
  key('ArrowRight');
  expect(page).not.toHaveBeenCalled();
  await idle();
  expect(page).toHaveBeenCalledTimes(2);
  await act(async () => finish({ items: [], hasMore: true }));
  await idle();
  expect(page).toHaveBeenCalledTimes(3);
  expect(button('下一项媒体').disabled).toBe(true);
  await act(async () => finish({ items: [items[1]!], hasMore: false }));
  expect(document.querySelector('img')?.src).toBe(items[0]!.src);
  expect(button('下一项媒体').disabled).toBe(false);
  act(() => button('下一项媒体').click());
  expect(document.querySelector('video')?.src).toBe(items[1]!.src);
  expect(button('下一项媒体').disabled).toBe(true);
  expect(button('上一项媒体').disabled).toBe(false);
  key('ArrowRight');
  expect(page).toHaveBeenCalledTimes(3);
  expect(document.querySelector('.weq-preview-business')?.textContent).not.toContain('没有');
  await act(async () =>
    root.render(
      h(MediaPreview, {
        items: [items[0]!, items[1]!, items[2]!],
        hasOlder: true,
        hasNewer: true,
        prefetchAdjacent: true,
        loadPage: page,
        onClose: vi.fn(),
      }),
    ),
  );
  expect(button('下一项媒体').disabled).toBe(false);
  expect(document.querySelector('video')?.src).toBe(items[1]!.src);
  act(() => button('下一项媒体').click());
  expect(document.querySelector('img')?.src).toBe(items[2]!.src);
  expect(button('下一项媒体').disabled).toBe(true);
  expect(page).toHaveBeenCalledTimes(3);
});
it('相邻媒体后台读取失败可重试，重试不移动当前项', async () => {
  const idle = usePrefetchClock();
  const page = vi
    .fn()
    .mockRejectedValueOnce(new Error('fixture'))
    .mockResolvedValueOnce({ items: [items[1]!], hasMore: false });
  await act(async () =>
    root.render(
      h(MediaPreview, {
        items: [items[0]!],
        hasNewer: true,
        prefetchAdjacent: true,
        loadPage: page,
        onClose: vi.fn(),
      }),
    ),
  );
  await idle();
  expect(button('下一项媒体').disabled).toBe(true);
  expect(page).toHaveBeenCalledTimes(1);
  const retry = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('加载失败'),
  )!;
  await act(async () => retry.click());
  expect(document.querySelector('img')?.src).toBe(items[0]!.src);
  expect(button('下一项媒体').disabled).toBe(false);
  expect(page).toHaveBeenCalledTimes(2);
});
it('开发严格模式只启动一次预取，交互期间及关闭后不再读空页', async () => {
  const idle = usePrefetchClock();
  const finish: Array<(value: { items: PreviewMedia[]; hasMore: boolean }) => void> = [];
  const page = vi.fn(
    () =>
      new Promise<{ items: PreviewMedia[]; hasMore: boolean }>((resolve) => finish.push(resolve)),
  );
  await act(async () =>
    root.render(
      h(
        StrictMode,
        null,
        h(MediaPreview, {
          items: [items[0]!],
          hasNewer: true,
          prefetchAdjacent: true,
          loadPage: page,
          onClose: vi.fn(),
        }),
      ),
    ),
  );
  expect(page).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(100));
  document.dispatchEvent(new Event('wheel', { bubbles: true }));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(page).not.toHaveBeenCalled();
  await idle();
  expect(page).toHaveBeenCalledOnce();
  await act(async () => finish[0]!({ items: [], hasMore: true }));
  expect(button('下一项媒体').disabled).toBe(true);
  await act(async () => root.render(null));
  await idle();
  expect(page).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('同文档图片和视频预览互相替换', async () => {
  act(() => root.render(h(MediaPreviewHost)));
  await act(async () =>
    openMediaPreview({ items: [{ key: items[0]!.src, kind: 'image', src: items[0]!.src }] }),
  );
  act(() =>
    openMediaPreview({ items: [{ key: items[1]!.src, kind: 'video', src: items[1]!.src }] }),
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('video')).not.toBeNull();
});
it('视频加载中也保留原生播放器的Tab入口，不把焦点锁在关闭按钮', () => {
  act(() => root.render(h(MediaPreview, { items: [items[1]!], onClose: vi.fn() })));
  button('关闭预览').focus();
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => button('关闭预览').dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
});
it('已挂载视频只用原生加载提示，播放失败仍可重试', () => {
  act(() => root.render(h(MediaPreview, { items: [items[1]!], onClose: vi.fn() })));
  const player = document.querySelector('video')!;
  expect(player.controls).toBe(true);
  expect(document.querySelector('[data-media-state]')?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('.weq-media-load-status')).toBeNull();
  act(() => player.dispatchEvent(new Event('error')));
  expect(document.querySelector('.weq-media-load-error')?.textContent).toContain(
    '视频暂时无法播放',
  );
  act(() => button('重试加载视频').click());
  const retryPlayer = document.querySelector('video')!;
  expect(retryPlayer).not.toBe(player);
  expect(document.querySelector('.weq-media-load-status')).toBeNull();
  act(() => retryPlayer.dispatchEvent(new Event('canplay')));
  expect(document.querySelector('[data-media-state]')?.getAttribute('data-media-state')).toBe(
    'ready',
  );
});
it('视频原片解析期间显示一组加载提示，播放器挂载后交由原生提示接管', async () => {
  let finish!: (value: { src: string; kind: 'video' }) => void;
  const detail = new Promise<{ src: string; kind: 'video' }>((resolve) => {
    finish = resolve;
  });
  await act(async () =>
    root.render(
      h(MediaPreview, { items: [{ ...items[1]!, load: () => detail }], onClose: vi.fn() }),
    ),
  );
  expect(document.querySelector('video')).toBeNull();
  expect(document.querySelectorAll('.weq-media-load-status')).toHaveLength(1);
  expect(document.querySelector('.weq-media-load-status')?.textContent).toBe('正在加载视频…');
  await act(async () => finish({ src: items[1]!.src, kind: 'video' }));
  expect(document.querySelector('video')?.controls).toBe(true);
  expect(document.querySelector('.weq-media-load-status')).toBeNull();
});
it('图片加载时继续保留一组加载提示', () => {
  act(() => root.render(h(MediaPreview, { items: [items[0]!], onClose: vi.fn() })));
  expect(document.querySelectorAll('.weq-media-load-status')).toHaveLength(1);
  expect(document.querySelector('.weq-media-load-status')?.textContent).toBe('正在加载图片…');
  load();
  expect(document.querySelector('.weq-media-load-status')).toBeNull();
});
it('详情返回相同图片地址时不把已绘制图片退回永久加载态', async () => {
  let finish!: (value: { src: string; kind: 'image' }) => void;
  const detail = new Promise<{ src: string; kind: 'image' }>((resolve) => {
    finish = resolve;
  });
  act(() =>
    root.render(
      h(MediaPreview, { items: [{ ...items[0]!, load: () => detail }], onClose: vi.fn() }),
    ),
  );
  load();
  expect(document.querySelector('[data-media-state]')?.getAttribute('data-media-state')).toBe(
    'ready',
  );
  await act(async () => finish({ src: items[0]!.src, kind: 'image' }));
  expect(document.querySelector('[data-media-state]')?.getAttribute('data-media-state')).toBe(
    'ready',
  );
});
it('视频原片解析失败后只展示重试，不把封面挂载成播放器', async () => {
  await act(async () =>
    root.render(
      h(MediaPreview, {
        items: [
          {
            key: 'video-cover',
            kind: 'video',
            src: items[0]!.src,
            load: async () => {
              throw new Error('fixture');
            },
          },
        ],
        onClose: vi.fn(),
      }),
    ),
  );
  expect(document.querySelector('video')).toBeNull();
  expect(document.querySelector('.weq-media-load-error')?.textContent).toContain(
    '视频暂时无法播放',
  );
  expect(button('重试加载视频')).not.toBeNull();
});
it('迟到OCR不能覆盖下一张图片', async () => {
  let finish!: (value: unknown) => void;
  mocks.ocr.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first: PreviewMedia = {
    ...items[0]!,
    ocr: { peerType: 'c2c', fileToken: 'fixture', width: 10, height: 10 },
  };
  act(() => root.render(h(MediaPreview, { items: [first, items[2]!], onClose: vi.fn() })));
  load();
  await act(async () =>
    [...document.querySelectorAll('button')].find((item) => item.textContent === 'OCR')!.click(),
  );
  key('ArrowRight');
  await act(async () =>
    finish({
      blocks: [{ text: '不该出现', rect: { x: 0, y: 0, width: 10, height: 10 } }],
      source: 'local',
    }),
  );
  expect(document.querySelector('.weq-ocr-panel')).toBeNull();
  expect(document.querySelector('img')?.src).toBe(items[2]!.src);
});
it('聊天元素按消息与元素位置标识，不混入闪照、表情和嵌套转发', () => {
  const pic = { type: 'pic', data: { fileToken: 'same', fileName: 'same.png' } };
  const result = galleryMedia([
    {
      msgId: '1',
      sendTime: 1,
      elements: [
        pic,
        pic,
        { type: 'video', data: { fileToken: 'video' } },
        { type: 'pic', data: { subType: 1 } },
        { type: 'pic', data: { isFlash: true } },
        { type: 'multiMsg', data: { elements: [pic] } },
      ],
    },
    { msgId: '2', sendTime: 2, elements: [pic] },
  ]);
  expect(result.map((item) => item.key)).toEqual(['1:0', '1:1', '1:2', '2:0']);
  expect(result[0]!.src).toBe(result[1]!.src);
  expect(result[2]!.kind).toBe('video');
  expect(
    galleryMedia([
      {
        msgId: '1',
        msgSeq: '10',
        source: 'roaming',
        sourceFormat: 'native',
        sendTime: 1,
        elements: [pic],
      },
      {
        msgId: '1',
        msgSeq: '11',
        source: 'roaming',
        sourceFormat: 'native',
        sendTime: 1,
        elements: [pic],
      },
    ]).map((item) => item.key),
  ).toEqual(['roaming:native:10:1:0', 'roaming:native:11:1:0']);
});
it('商城表情使用无全屏遮罩的小浮层，图片主动复用聊天路径并保留加密回退与分级Escape', () => {
  act(() => root.render(h(MarketFaceLightbox)));
  act(() => openMarketFaceLightbox('123', 'fixture'));
  expect(document.querySelector('.weq-unified-preview')).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('.weq-mface-popover-layer.is-popover')).not.toBeNull();
  const image = document.querySelector<HTMLImageElement>('.weq-mface-lb-cell img')!;
  const source = new URL(image.src);
  expect(source.searchParams.get('intent')).toBe('interactive');
  expect(source.searchParams.has('enc')).toBe(false);
  act(() => image.dispatchEvent(new Event('error')));
  expect(new URL(image.src).searchParams.get('enc')).toBe('tea');
  expect(new URL(image.src).searchParams.get('intent')).toBe('interactive');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  act(() => document.querySelector<HTMLButtonElement>('.weq-mface-lb-cell')!.click());
  expect(document.querySelector('.weq-mface-detail')?.textContent).toContain('fixture-key');
  // 网格按钮卸载后焦点可回落到 body，Esc 仍须先返回整包。
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('.weq-mface-lb-grid')).not.toBeNull();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  key('Escape');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('省流量模式下整包与详情均为主动请求，失败后可重新加载且不依赖密钥', () => {
  const previous = useDataSaver.getState();
  try {
    act(() => useDataSaver.setState({ enabled: true }));
    act(() => root.render(h(MarketFaceLightbox)));
    act(() => openMarketFaceLightbox('123'));
    const cell = document.querySelector<HTMLImageElement>('.weq-mface-lb-cell img')!;
    expect(new URL(cell.src).searchParams.get('intent')).toBe('interactive');
    act(() => document.querySelector<HTMLButtonElement>('.weq-mface-lb-cell')!.click());
    const image = document.querySelector<HTMLImageElement>('.weq-mface-detail-image')!;
    expect(new URL(image.src).searchParams.has('enc')).toBe(false);
    act(() => image.dispatchEvent(new Event('error')));
    expect(new URL(image.src).searchParams.get('enc')).toBe('tea');
    act(() => image.dispatchEvent(new Event('error')));
    expect(document.querySelector('.weq-mface-detail-image')).toBeNull();
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('重试加载'),
    )!;
    act(() => retry.click());
    const retried = document.querySelector<HTMLImageElement>('.weq-mface-detail-image')!;
    expect(new URL(retried.src).searchParams.has('enc')).toBe(false);
    expect(new URL(retried.src).searchParams.get('intent')).toBe('interactive');
  } finally {
    act(() => useDataSaver.setState(previous));
  }
});
it('真实聊天入口传递锚点，同包切换更新高亮，点击背景继续操作且切号关闭', () => {
  const clicked = vi.fn();
  act(() =>
    root.render(
      h(
        'div',
        null,
        h(QqMarketFace, { data: { emojiPackId: 123, marketEmoticonIdHex: 'fixture' } }),
        h(QqMarketFace, { data: { emojiPackId: 123, marketEmoticonIdHex: 'other' } }),
        h('button', { onClick: clicked, id: 'outside' }, '背景操作'),
        h(MarketFaceLightbox),
      ),
    ),
  );
  const triggers = document.querySelectorAll<HTMLButtonElement>('.qq-mface-wrap');
  act(() => triggers[0]!.click());
  expect(document.querySelector('.weq-mface-popover-layer.is-anchored-popover')).not.toBeNull();
  expect(document.querySelector('.weq-mface-lb-cell.is-active')).not.toBeNull();
  act(() => triggers[1]!.click());
  expect(document.querySelectorAll('.weq-mface-popover')).toHaveLength(1);
  expect(document.querySelector('.weq-mface-lb-cell.is-active')).toBeNull();
  const outside = document.querySelector<HTMLButtonElement>('#outside')!;
  act(() => {
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    outside.click();
  });
  expect(document.querySelector('.weq-mface-popover')).toBeNull();
  expect(clicked).toHaveBeenCalledOnce();
  act(() => triggers[0]!.click());
  const previous = useViewState.getState().openedUin;
  act(() => useViewState.getState().setOpenedUin('different-fixture-account'));
  expect(document.querySelector('.weq-mface-popover')).toBeNull();
  act(() => useViewState.getState().setOpenedUin(previous));
});
it('真实消息渲染入口接入混排、双向分页、实时追加和账号切换', async () => {
  const idle = usePrefetchClock();
  mocks.bound = true;
  const picture = {
    type: 'pic',
    data: { fileName: 'fixture.png', fileToken: 'fixture', imgWidth: 10, imgHeight: 10 },
  };
  const messages = [
    { msgId: '10', msgSeq: '10', sendTime: '10', elements: [picture] },
    {
      msgId: '20',
      msgSeq: '20',
      sendTime: '20',
      elements: [{ type: 'video', data: { fileToken: 'video', fileName: 'video.webm' } }],
    },
  ];
  mocks.page.mockImplementation(async ({ direction }: { direction: 'older' | 'newer' }) => ({
    items:
      direction === 'older'
        ? [{ msgId: '1', msgSeq: '1', sendTime: '1', elements: [picture] }]
        : [],
    hasMore: false,
    cursor: { msgSeq: '1', sendTime: '1', msgId: '1' },
  }));
  const scene = (entries: typeof messages) =>
    h(
      'div',
      null,
      h(
        ChatMediaGallery,
        {
          messages: entries,
          conv: 'u_peer',
          kind: 'c2c',
          paged: true,
        },
        entries.map((message) =>
          h(QqMessageContent, {
            key: message.msgId,
            elements: message.elements,
            msgId: message.msgId,
            sendTimeMs: Number(message.sendTime) * 1000,
          }),
        ),
      ),
      h(MediaPreviewHost),
    );
  await act(async () => root.render(scene(messages)));
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="查看图片：fixture.png"]',
  )!;
  await act(async () => trigger.click());
  await idle();
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('2 / 3');
  await act(async () => button('上一项媒体').click());
  expect(mocks.page.mock.calls[0]![0]).toMatchObject({
    conv: 'u_peer',
    direction: 'older',
    anchorMsgId: '10',
    expectedAccountConfigId: 'fixture-a',
  });
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('1 / 3');
  expect(button('上一项媒体').disabled).toBe(true);
  await act(async () =>
    root.render(
      scene([
        { msgId: '0', msgSeq: '0', sendTime: '0', elements: [picture] },
        ...messages,
        { msgId: '30', msgSeq: '30', sendTime: '30', elements: [picture] },
      ]),
    ),
  );
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('2 / 5');
  expect(button('上一项媒体').disabled).toBe(false);
  await act(async () => button('下一项媒体').click());
  await act(async () => button('下一项媒体').click());
  expect(document.querySelector('.weq-unified-preview video')).not.toBeNull();
  await act(async () => button('下一项媒体').click());
  expect(button('下一项媒体').disabled).toBe(true);
  mocks.configId = 'fixture-b';
  await act(async () => root.render(scene(messages)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
