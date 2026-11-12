import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MediaPreview,
  mergePreviewMedia,
  type PreviewMedia,
} from '../src/renderer/src/components/MediaPreview';
import { ChatMediaGallery, galleryMedia } from '../src/renderer/src/components/ChatMediaGallery';
import { QqMessageContent } from '../src/renderer/src/components/QqMessageContent';
import {
  MarketFaceLightbox,
  openMarketFaceLightbox,
} from '../src/renderer/src/components/MarketFaceLightbox';
import { ImageLightbox, openLightbox } from '../src/renderer/src/components/ImageLightbox';
import { VideoLightbox, openVideoLightbox } from '../src/renderer/src/components/VideoLightbox';

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
});
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
it('同文档图片和视频预览互相替换', () => {
  act(() => root.render(h('div', null, h(ImageLightbox), h(VideoLightbox))));
  act(() => openLightbox(items[0]!.src));
  act(() => openVideoLightbox(items[1]!.src));
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
it('商城表情复用外壳后保留整组、参数与分级Escape，打开时替换旧图片预览', () => {
  act(() => root.render(h('div', null, h(ImageLightbox), h(MarketFaceLightbox))));
  act(() => openLightbox(items[0]!.src));
  act(() => openMarketFaceLightbox('123'));
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  act(() => document.querySelector<HTMLButtonElement>('.weq-mface-lb-cell')!.click());
  expect(document.querySelector('.weq-mface-detail')?.textContent).toContain('fixture-key');
  key('Escape');
  expect(document.querySelector('.weq-mface-lb-grid')).not.toBeNull();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  key('Escape');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('真实消息渲染入口接入混排、双向分页、实时追加和账号切换', async () => {
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
  mocks.page.mockResolvedValue({
    items: [{ msgId: '1', msgSeq: '1', sendTime: '1', elements: [picture] }],
    hasMore: false,
    cursor: { msgSeq: '1', sendTime: '1', msgId: '1' },
  });
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
      h(ImageLightbox),
    );
  await act(async () => root.render(scene(messages)));
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="查看图片：fixture.png"]',
  )!;
  await act(async () => trigger.click());
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('1 / 2');
  await act(async () => button('上一项媒体').click());
  expect(mocks.page.mock.calls[0]![0]).toMatchObject({
    conv: 'u_peer',
    direction: 'older',
    anchorMsgId: '10',
    expectedAccountConfigId: 'fixture-a',
  });
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('1 / 3');
  await act(async () =>
    root.render(
      scene([...messages, { msgId: '30', msgSeq: '30', sendTime: '30', elements: [picture] }]),
    ),
  );
  expect(document.querySelector('.weq-preview-count')?.textContent).toContain('1 / 4');
  await act(async () => button('下一项媒体').click());
  await act(async () => button('下一项媒体').click());
  expect(document.querySelector('.weq-unified-preview video')).not.toBeNull();
  mocks.configId = 'fixture-b';
  await act(async () => root.render(scene(messages)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
