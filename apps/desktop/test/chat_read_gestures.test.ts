import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('新消息按钮已读行为', () => {
  it.each([true, false])('点击新消息跳到底部，仅最新窗口标记已读：atLatest=%s', (atLatest) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const read = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const first = {
      ...demo.messages[0]!,
      id: 'read-first',
      conversationId: conversation.id,
      body: '合成旧消息',
      qqElements: [{ type: 'text', data: { textContent: '合成旧消息' } }],
    };
    const next = { ...first, id: 'read-second', body: '合成新消息' };
    const props = {
      user: demo.user,
      conversation,
      loading: false,
      atLatest,
      draft: '',
      onReadCurrentConversation: read,
      onSend: vi.fn(),
      onDraftChange: vi.fn(),
      onDraftClear: vi.fn(),
      onBack: vi.fn(),
    };
    try {
      act(() => root.render(createElement(ChatPane, { ...props, messages: [first] })));
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        scroll.scrollTop = 100;
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      act(() => root.render(createElement(ChatPane, { ...props, messages: [first, next] })));
      const button = host.querySelector<HTMLButtonElement>('.new-message-pill');
      if (!atLatest) {
        expect(button).toBeNull();
        expect(read).not.toHaveBeenCalled();
        return;
      }
      expect(button).not.toBeNull();
      expect(read).not.toHaveBeenCalled();
      act(() => button!.click());
      expect(host.querySelector('.new-message-pill')).toBeNull();
      expect(read).toHaveBeenCalledWith(conversation);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
