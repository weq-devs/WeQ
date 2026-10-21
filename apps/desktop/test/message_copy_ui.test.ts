import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { QqMessageContent } from '../src/renderer/src/components/QqMessageContent';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { RepeatElement } from '../src/renderer/src/lib/messageRepeat';

const copied = vi.hoisted(() => vi.fn(async (_value: { text: string; html: string }) => true));
vi.mock('../src/renderer/src/lib/mentionClipboard', async (original) => ({
  ...(await original<object>()),
  writeMentionClipboard: copied,
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
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  copied.mockClear();
});

function mount(pureFace = false, override?: RepeatElement[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const elements =
    override ??
    (pureFace
      ? [{ type: 'face', data: { faceId: 14, faceText: '[微笑]', subType: 1 } }]
      : [
          {
            type: 'reply',
            data: {
              origText: '原话',
              origElements: [{ type: 'text', data: { textContent: '原话' } }],
              origSenderDisplayName: '原作者',
            },
          },
          { type: 'text', data: { textContent: '前' } },
          { type: 'face', data: { faceId: 14, faceText: '[微笑]', subType: 1 } },
          { type: 'text', data: { textContent: '后' } },
        ]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(ChatPane, {
        draft: '',
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        user: demo.user,
        conversation,
        messages: [
          {
            id: 'copy-fixture',
            conversationId: conversation.id,
            senderId: conversation.otherUser.id,
            body: '',
            qqElements: elements,
            createdAt: '2026-10-21T01:00:00Z',
          },
        ],
        loading: false,
        onBack: vi.fn(),
        messageRenderers: [
          {
            id: 'qq-fixture',
            match: () => true,
            render: () => h(QqMessageContent, { elements, sendTimeMs: 0, msgId: 'copy-fixture' }),
          },
        ],
      }),
    ),
  );
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
async function copyMenu(host: HTMLElement, target: Element) {
  act(() =>
    target.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
    ),
  );
  const copy = [...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')].find(
    (button) => button.textContent?.trim() === '复制',
  );
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
}
describe('聊天内容复制交互', () => {
  it('右键复制卡片包含类型、标题、描述和链接，不是旧的卡片占位文字', async () => {
    const f = mount(false, [
      {
        type: 'ark',
        data: {
          arkData: {
            app: 'com.tencent.structmsg',
            meta: {
              news: {
                title: '合成分享标题',
                desc: '合成摘要',
                jumpUrl: 'https://example.invalid/shared',
              },
            },
          },
        },
      },
    ]);
    try {
      await copyMenu(f.host, f.host.querySelector('.message-bubble')!);
      expect(copied).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('[链接卡片]') }),
      );
      const value = copied.mock.calls[0]![0] as { text: string; html: string };
      expect(value.text).toContain('合成分享标题');
      expect(value.text).toContain('合成摘要');
      expect(value.text).toContain('https://example.invalid/shared');
    } finally {
      f.close();
    }
  });
  it('右键前的混合选区在菜单打开后仍按选中范围复制', async () => {
    const f = mount();
    try {
      const body = f.host.querySelector('.qq-reply-body')!;
      const range = document.createRange();
      range.selectNodeContents(body);
      window.getSelection()!.addRange(range);
      await copyMenu(f.host, body);
      expect(copied).toHaveBeenCalledWith(expect.objectContaining({ text: '前[微笑]后' }));
    } finally {
      f.close();
    }
  });
  it('右键引用只复制引用，复制事件也保留块与表情内容', async () => {
    const f = mount();
    try {
      await copyMenu(f.host, f.host.querySelector('.qq-reply-quote')!);
      expect(copied).toHaveBeenCalledWith(expect.objectContaining({ text: '> 原作者\n> 原话' }));
      const content = f.host.querySelector('.qq-has-reply')!;
      const range = document.createRange();
      range.selectNodeContents(content);
      window.getSelection()!.addRange(range);
      const setData = vi.fn();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData } });
      act(() => content.dispatchEvent(event));
      expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('前[微笑]后'));
      expect(setData).toHaveBeenCalledWith('text/html', expect.stringContaining('blockquote'));
      expect(event.defaultPrevented).toBe(true);
    } finally {
      f.close();
    }
  });
  it('纯表情长按后可复制非空替代文字', () => {
    vi.useFakeTimers();
    const f = mount(true);
    try {
      const bubble = f.host.querySelector('.message-bubble')!;
      act(() =>
        bubble.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }),
        ),
      );
      act(() => vi.advanceTimersByTime(500));
      expect(window.getSelection()?.rangeCount).toBe(1);
      const setData = vi.fn();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData } });
      act(() => bubble.dispatchEvent(event));
      expect(setData).toHaveBeenCalledWith('text/plain', '[微笑]');
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
});
