import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { QqMessageContent } from '../src/renderer/src/components/QqMessageContent';
import { ReplyJumpContext } from '../src/renderer/src/state/messageContext';
import { useDataSaver } from '../src/renderer/src/lib/dataSaver';

const dataSaverPolicy = useDataSaver.getState();

const gallery = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({ close: vi.fn(), update: vi.fn() })),
);
vi.mock('../src/renderer/src/components/mediaPreviewStore', () => ({
  openMediaPreview: gallery,
  MediaPreviewHost: () => null,
}));
vi.mock('../src/renderer/src/components/mediaPreviewStore.shared', () => ({
  openMediaPreview: gallery,
  MediaPreviewHost: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  gallery.mockClear();
  useDataSaver.setState(dataSaverPolicy);
});

function mount({
  media = 'pic',
  quoted = true,
  seq = 42,
  previewElements = [media],
  imageData = {} as Record<string, unknown>,
  bodyImage = false,
} = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IntersectionObserver', undefined);
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const preview = {
    type: media,
    data: { fileName: 'synthetic.png', imgWidth: 400, imgHeight: 300, ...imageData },
  };
  const elements = quoted
    ? [
        {
          type: 'reply',
          data: {
            origMsgSeq: seq,
            origMsgTime: 1700000000,
            origElements: previewElements.map((type) =>
              type === 'text' ? { type, data: { textContent: '图文说明' } } : { ...preview, type },
            ),
          },
        },
      ]
    : [preview];
  if (bodyImage) elements.push({ type: 'pic', data: { fileName: 'body.png' } });
  const host = document.createElement('div');
  document.body.append(host);
  const jump = vi.fn((_target: { seq?: string | number }) => {
    host.querySelector<HTMLElement>('.message-scroll')!.scrollTop = 120;
  });
  function Harness() {
    const [revision, setRevision] = useState(0);
    return h(
      ReplyJumpContext.Provider,
      {
        value: (target) => {
          jump(target);
          setRevision(revision + 1);
        },
      },
      h(ChatPane, {
        user: demo.user,
        conversation,
        draft: '',
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        onBack: vi.fn(),
        loading: false,
        messages: [
          {
            id: 'quote',
            conversationId: conversation.id,
            senderId: demo.user.id,
            body: '',
            createdAt: '2026-10-25T16:00:00Z',
            qqElements: elements,
          },
        ],
        messageRenderers: [
          {
            id: `fixture-${revision}`,
            match: () => true,
            render: () => h(QqMessageContent, { elements, sendTimeMs: 0, msgId: 'quote' }),
          },
        ],
      }),
    );
  }
  const root = createRoot(host);
  const navigate = vi.fn();
  act(() => root.render(h('div', { onKeyDown: navigate }, h(Harness))));
  act(() => vi.advanceTimersByTime(50));
  const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
  scroll.scrollTop = 800;
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, jump, scroll, navigate };
}

it.each(['.qq-reply-quote-arrow', '.qq-reply-quote-sender'])(
  '点击 %s 后的消息刷新不会把引用跳转拉回底部',
  (selector) => {
    const f = mount();
    act(() =>
      f.host
        .querySelector<HTMLElement>(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(f.jump).toHaveBeenCalledOnce();
    expect(f.scroll.scrollTop).toBe(120);
  },
);

it('引用视频仍只跳转原消息，不同时打开灯箱或播放视频', () => {
  const f = mount({ media: 'video' });
  act(() => f.host.querySelector<HTMLElement>('.qq-reply-preview-media img')!.click());
  expect(f.jump).toHaveBeenCalledOnce();
  expect(f.jump).toHaveBeenCalledWith(expect.objectContaining({ seq: 42 }));
  expect(gallery).not.toHaveBeenCalled();
  expect(f.host.querySelector('video')).toBeNull();
  expect(f.scroll.scrollTop).toBe(120);
});

it.each([0, 42])('引用图片可独立预览，不依赖跳转序号 %i，也不预览正文图片', (seq) => {
  const f = mount({ seq, bodyImage: true });
  act(() => f.host.querySelector<HTMLElement>('.qq-reply-preview-media img')!.click());
  expect(f.jump).not.toHaveBeenCalled();
  expect(gallery).toHaveBeenCalledOnce();
  const options = gallery.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    items: [{ kind: 'image', title: 'synthetic.png' }],
    ownerDocument: document,
  });
  expect(options).not.toHaveProperty('initialKey');
  expect(f.scroll.scrollTop).toBe(800);
});

function failQuotedImage(host: HTMLElement): void {
  for (let i = 0; i < 4; i++) {
    const image = host.querySelector('.qq-reply-preview-media img');
    if (!image) return;
    act(() => image.dispatchEvent(new Event('error')));
  }
  expect(host.querySelector('.qq-reply-preview-media img')).toBeNull();
}

it('省流量引用图片可点击加载，携带原消息时间与主动加载意图，不触发跳转', () => {
  useDataSaver.setState({ enabled: true });
  const f = mount();
  failQuotedImage(f.host);
  const load = f.host.querySelector<HTMLButtonElement>('button[aria-label="加载图片"]')!;
  expect(load).not.toBeNull();
  expect(load.disabled).toBe(false);
  act(() => load.click());
  const image = f.host.querySelector<HTMLImageElement>('.qq-reply-preview-media img')!;
  expect(image).not.toBeNull();
  const url = new URL(image.src);
  expect(url.searchParams.get('intent')).toBe('interactive');
  expect(url.searchParams.get('t')).toBe('1700000000000');
  expect(url.searchParams.get('name')).toBe('synthetic.png');
  expect(f.jump).not.toHaveBeenCalled();
  expect(gallery).not.toHaveBeenCalled();
  act(() => image.click());
  expect(gallery).toHaveBeenCalledOnce();
  expect(f.jump).not.toHaveBeenCalled();
});

it('引用图片失败后可重试，不触发跳转', () => {
  const f = mount();
  failQuotedImage(f.host);
  const retry = f.host.querySelector<HTMLButtonElement>('.qq-media-retry')!;
  expect(retry).not.toBeNull();
  act(() => retry.click());
  expect(f.host.querySelector('.qq-reply-preview-media img')).not.toBeNull();
  expect(f.jump).not.toHaveBeenCalled();
  expect(gallery).not.toHaveBeenCalled();
});

it.each(['Enter', ' '])('引用图片保留原生键盘 %j 操作，不触发引用或消息行导航', (key) => {
  const f = mount();
  const control = f.host.querySelector<HTMLButtonElement>('.qq-reply-preview-media button')!;
  expect(control).not.toBeNull();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => control.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.jump).not.toHaveBeenCalled();
});

it.each([
  ['pic', 'text'],
  ['text', 'pic'],
  ['text', 'pic', 'text', 'pic'],
])('图文引用按原顺序保留文字和图片：%j', (...previewElements) => {
  const f = mount({ previewElements });
  const body = f.host.querySelector<HTMLElement>('.qq-reply-quote-body')!;
  expect(
    Array.from(body.children)
      .filter((child) => child.tagName === 'SPAN')
      .map((child) => (child.classList.contains('qq-reply-preview-media') ? 'pic' : 'text')),
  ).toEqual(previewElements);
  expect(body.textContent).toContain('图文说明');
  expect(body.querySelectorAll('img')).toHaveLength(
    previewElements.filter((type) => type === 'pic').length,
  );
  act(() => body.querySelector<HTMLElement>('.qq-reply-preview-media img')!.click());
  expect(f.jump).not.toHaveBeenCalled();
  expect(gallery).toHaveBeenCalledOnce();
  act(() => body.querySelector<HTMLElement>(':scope > span:not(.qq-reply-preview-media)')!.click());
  expect(f.jump).toHaveBeenCalledOnce();
});

it('引用闪照可打开自身预览，不触发原消息跳转', () => {
  const f = mount({ imageData: { fileToken: '/10001-2-ABC', isFlash: true } });
  act(() => f.host.querySelector<HTMLButtonElement>('.qq-flash-cover')!.click());
  expect(gallery).toHaveBeenCalledOnce();
  expect(f.jump).not.toHaveBeenCalled();
});

it.each(['Enter', ' '])('引用框键盘 %j 跳转并阻止默认滚动', (key) => {
  const f = mount();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => f.host.querySelector<HTMLElement>('.qq-reply-quote')!.dispatchEvent(event));
  expect(f.jump).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  expect(f.scroll.scrollTop).toBe(120);
});

it('无有效引用序号时不伪造跳转，也不退出贴底', () => {
  const f = mount({ seq: 0 });
  const quote = f.host.querySelector<HTMLElement>('.qq-reply-quote')!;
  act(() => quote.click());
  expect(quote.getAttribute('role')).toBeNull();
  expect(f.jump).not.toHaveBeenCalled();
  expect(f.scroll.scrollTop).toBe(800);
});

it('普通正文图片打开连续预览，不触发引用跳转', () => {
  const f = mount({ quoted: false });
  act(() => f.host.querySelector<HTMLElement>('.qq-media-image')!.click());
  expect(gallery).toHaveBeenCalledOnce();
  expect(gallery.mock.calls[0]?.[0]).toMatchObject({ initialKey: 'quote:0' });
  expect(f.jump).not.toHaveBeenCalled();
});
