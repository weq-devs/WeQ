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
  it('已排队的贴底补偿不能覆盖用户刚刚向上滚动的位置', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          createElement(ChatPane, {
            user: demo.user,
            conversation,
            messages: [{ ...demo.messages[0]!, conversationId: conversation.id }],
            loading: false,
            atLatest: true,
            draft: '',
            onSend: vi.fn(),
            onDraftChange: vi.fn(),
            onDraftClear: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 2000 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        scroll.scrollTop = 200;
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        for (const callback of frames.splice(0)) callback(0);
      });
      expect(scroll.scrollTop).toBe(200);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('恢复会话阅读位置后，下方加载与追加新消息均不自动滚动', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const first = { ...demo.messages[0]!, id: 'saved-row', conversationId: conversation.id };
    const props = {
      user: demo.user,
      conversation,
      loading: false,
      atLatest: true,
      initialReadingPosition: { scrollTop: 120 },
      draft: '',
      onSend: vi.fn(),
      onDraftChange: vi.fn(),
      onDraftClear: vi.fn(),
      onBack: vi.fn(),
    };
    try {
      act(() =>
        root.render(createElement(ChatPane, { ...props, messages: [first], loadingNewer: true })),
      );
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      expect(scroll.scrollTop).toBe(120);
      expect(scroll.querySelector('[aria-label="正在加载后续消息"]')).not.toBeNull();
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 1600 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        for (const callback of frames.splice(0)) callback(0);
      });
      expect(scroll.scrollTop).toBe(120);
      act(() =>
        root.render(
          createElement(ChatPane, {
            ...props,
            messages: [first, { ...first, id: 'new-row' }],
            loadingNewer: false,
          }),
        ),
      );
      expect(scroll.scrollTop).toBe(120);
      expect(scroll.querySelector('[aria-label="正在加载后续消息"]')).toBeNull();
      act(() =>
        root.render(
          createElement(ChatPane, {
            ...props,
            conversation: { ...conversation, id: 'another-chat' },
            messages: [first],
            initialReadingPosition: { scrollTop: 340 },
          }),
        ),
      );
      expect(scroll.scrollTop).toBe(340);
      act(() => root.render(createElement(ChatPane, { ...props, messages: [first] })));
      expect(scroll.scrollTop).toBe(120);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

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
      const button = host.querySelector<HTMLButtonElement>('.new-message-bottom');
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

  it.each(['self', 'peer'])('阅读历史时预览 %s 的新消息不移动主列表或标记已读', (sender) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'direct')!;
    const read = vi.fn();
    const preview = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const first = { ...demo.messages[0]!, id: 'old', conversationId: conversation.id };
    const next = { ...first, id: 'new', senderId: sender === 'self' ? demo.user.id : 'peer' };
    const props = {
      user: demo.user,
      conversation,
      loading: false,
      onPreviewLatest: preview,
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
      const button = host.querySelector<HTMLButtonElement>('.new-message-preview')!;
      expect(button.getAttribute('aria-label')).toBe('预览新消息');
      act(() => button.click());
      expect(preview).toHaveBeenCalledOnce();
      expect(preview).toHaveBeenCalledWith(conversation);
      expect(scroll.scrollTop).toBe(100);
      expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
      expect(read).not.toHaveBeenCalled();
      act(() =>
        root.render(
          createElement(ChatPane, {
            ...props,
            conversation: demo.conversations.find((item) => item.type === 'group'),
            messages: [],
          }),
        ),
      );
      expect(host.querySelector('.new-message-pill')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('分离的历史窗口按实时水位提示新消息，窗口底部不清除提示，定位失败保留重试入口', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const jump = vi.fn().mockResolvedValue(false);
    const read = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      user: demo.user,
      conversation,
      messages: [{ ...demo.messages[0]!, conversationId: conversation.id }],
      loading: false,
      atLatest: false,
      draft: '',
      onJumpToLatest: jump,
      onReadCurrentConversation: read,
      onSend: vi.fn(),
      onDraftChange: vi.fn(),
      onDraftClear: vi.fn(),
      onBack: vi.fn(),
    };
    try {
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740993' })),
      );
      expect(host.querySelector('.new-message-pill')).toBeNull();
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740995' })),
      );
      const pill = () => host.querySelector('.new-message-pill');
      expect(pill()?.textContent).toContain('2条新消息');
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740994' })),
      );
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740995' })),
      );
      expect(pill()?.textContent).toContain('2条新消息');
      act(() =>
        host
          .querySelector('.message-scroll')!
          .dispatchEvent(new Event('scroll', { bubbles: true })),
      );
      expect(pill()).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
      expect(jump).toHaveBeenCalledOnce();
      expect(pill()).not.toBeNull();
      expect(read).not.toHaveBeenCalled();
      // 历史分页、同水位刷新或水位回退不增加新消息计数。
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740994' })),
      );
      expect(pill()?.textContent).toContain('2条新消息');
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      jump.mockImplementation(async () => {
        root.render(
          createElement(ChatPane, {
            ...props,
            atLatest: true,
            latestMessageSeq: '9007199254740995',
          }),
        );
        return true;
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
      act(() => {
        for (const callback of frames) callback(0);
      });
      expect(pill()).toBeNull();
      expect(read).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledWith(conversation);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
