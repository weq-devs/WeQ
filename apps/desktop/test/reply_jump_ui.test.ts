import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  QqMessageContent,
  ReplyJumpContext,
} from '../src/renderer/src/components/QqMessageContent';

const lightbox = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/components/ImageLightbox', () => ({ openLightbox: lightbox }));
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
  lightbox.mockClear();
});

function mount({ media = 'pic', quoted = true, seq = 42 } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const preview = {
    type: media,
    data: { fileName: 'synthetic.png', imgWidth: 400, imgHeight: 300 },
  };
  const elements = quoted
    ? [
        {
          type: 'reply',
          data: {
            origMsgSeq: seq,
            origElements: [preview],
          },
        },
      ]
    : [preview];
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
  act(() => root.render(h(Harness)));
  act(() => vi.advanceTimersByTime(50));
  const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
  scroll.scrollTop = 800;
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, jump, scroll };
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

it.each(['pic', 'video'])('引用 %s 只跳转原消息，不同时打开灯箱或播放视频', (media) => {
  const f = mount({ media });
  act(() => f.host.querySelector<HTMLElement>('.qq-reply-preview-media img')!.click());
  expect(f.jump).toHaveBeenCalledOnce();
  expect(f.jump).toHaveBeenCalledWith(expect.objectContaining({ seq: 42 }));
  expect(lightbox).not.toHaveBeenCalled();
  expect(f.host.querySelector('video')).toBeNull();
  expect(f.scroll.scrollTop).toBe(120);
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

it('普通正文图片仍打开灯箱，不触发引用跳转', () => {
  const f = mount({ quoted: false });
  act(() => f.host.querySelector<HTMLElement>('.qq-media-image')!.click());
  expect(lightbox).toHaveBeenCalledOnce();
  expect(f.jump).not.toHaveBeenCalled();
});
