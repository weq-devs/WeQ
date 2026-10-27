import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.at(-1) === 'getSettings' ? settings.value : undefined,
              isLoading: false,
            })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
const settings = vi.hoisted(() => ({
  value: {} as { showScrollToBottomButton?: boolean; autoFollowLatestMessages?: boolean },
}));
afterEach(() => {
  settings.value = {};
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('新消息按钮已读行为', () => {
  it.each(['bottom', 'history', 'saved', 'interrupted'])(
    '异步内容增高只延续底部位置，不覆盖阅读锚点或新手势：%s',
    (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const observers: { targets: Set<Element>; fire: () => void }[] = [];
      vi.stubGlobal(
        'ResizeObserver',
        class implements ResizeObserver {
          targets = new Set<Element>();
          constructor(callback: ResizeObserverCallback) {
            observers.push({ targets: this.targets, fire: () => callback([], this) });
          }
          observe(target: Element) {
            this.targets.add(target);
          }
          unobserve(target: Element) {
            this.targets.delete(target);
          }
          disconnect() {
            this.targets.clear();
          }
        },
      );
      settings.value = { autoFollowLatestMessages: false };
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === 'direct')!;
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
              draft: '',
              initialReadingPosition: mode === 'saved' ? { scrollTop: 120 } : undefined,
            }),
          ),
        );
        const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
        let height = 1200;
        Object.defineProperties(scroll, {
          scrollHeight: { configurable: true, get: () => height },
          clientHeight: { configurable: true, value: 400 },
        });
        const move = (top: number) => {
          scroll.scrollTop = top;
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        act(() => {
          if (mode !== 'saved') move(mode === 'history' ? 100 : 800);
          for (const callback of frames.splice(0)) callback(0);
          if (mode === 'bottom' || mode === 'interrupted') move(800);
        });
        const observer = observers.find((item) =>
          [...item.targets].some((target) => target.classList.contains('weq-virtual-timeline')),
        )!;
        const beforeGrowth = scroll.scrollTop;
        act(() => {
          height = 1400;
          if (mode === 'bottom') move(850);
          observer.fire();
          if (mode === 'interrupted') {
            // 手势先到、滚动事件尚未到时也必须取消已排队的补偿。
            scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
          }
          for (const callback of frames.splice(0)) callback(0);
        });
        expect(scroll.scrollTop).toBe(mode === 'bottom' ? 1400 : beforeGrowth);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    [true, true],
    [false, true],
    [false, false],
  ])('整页校准仅在进入会话时定位底部：自动跟随=%s，原窗口为最新=%s', (enabled, initialAtLatest) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    settings.value = { autoFollowLatestMessages: enabled };
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const first = { ...demo.messages[0]!, id: 'cached', conversationId: conversation.id };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = { user: demo.user, conversation, draft: '' };
    const render = (messages: (typeof first)[], atLatest: boolean, loadingNewer: boolean) =>
      act(() =>
        root.render(createElement(ChatPane, { ...props, messages, atLatest, loadingNewer })),
      );
    try {
      render([first], initialAtLatest, false);
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 400 },
      });
      if (!initialAtLatest) scroll.scrollTop = 800;
      render([first], false, true);
      render([{ ...first, id: 'latest' }], true, false);
      expect(scroll.scrollTop).toBe(initialAtLatest ? 1200 : 800);
      expect(host.querySelector('.new-message-pill')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([false, true])(
    '带乐观尾部的首屏加载完成后定位底部，但保留用户主动滚动：%s',
    (scrolled) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
      settings.value = { autoFollowLatestMessages: false };
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === 'group')!;
      const tail = { ...demo.messages[0]!, id: 'optimistic', conversationId: conversation.id };
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const props = { user: demo.user, conversation, draft: '', atLatest: true };
      try {
        act(() =>
          root.render(createElement(ChatPane, { ...props, messages: [tail], loading: true })),
        );
        const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
        Object.defineProperties(scroll, {
          scrollHeight: { configurable: true, value: 1600 },
          clientHeight: { configurable: true, value: 400 },
        });
        if (scrolled)
          act(() => {
            scroll.scrollTop = 100;
            scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
        act(() =>
          root.render(
            createElement(ChatPane, {
              ...props,
              messages: [{ ...tail, id: 'history' }, tail],
              loading: false,
            }),
          ),
        );
        expect(scroll.scrollTop).toBe(scrolled ? 100 : 1600);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each([undefined, true, false])(
    '自动跟随=%s：底部追加、原尾部刷新及手动定位互不混淆',
    (enabled) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
      settings.value = { autoFollowLatestMessages: enabled };
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === 'group')!;
      const first = {
        ...demo.messages[0]!,
        id: 'first',
        conversationId: conversation.id,
        senderId: 'peer',
      };
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const props = { user: demo.user, conversation, draft: '', atLatest: true };
      const render = (messages: (typeof first)[], loading = false) =>
        act(() => root.render(createElement(ChatPane, { ...props, messages, loading })));
      try {
        render([], true);
        const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
        Object.defineProperties(scroll, {
          scrollHeight: { configurable: true, value: 1200 },
          clientHeight: { configurable: true, value: 400 },
        });
        render([first]);
        expect(scroll.scrollTop).toBe(1200);
        expect(host.querySelector('.new-message-pill')).toBeNull();
        act(() => {
          scroll.scrollTop = 800;
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        // 尾部不变的补全也必须遵守开关。
        render([{ ...first }]);
        expect(scroll.scrollTop).toBe(enabled === false ? 800 : 1200);
        const second = { ...first, id: 'second' };
        render([first, second]);
        expect(scroll.scrollTop).toBe(enabled === false ? 800 : 1200);
        if (enabled === false) {
          expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
          const own = { ...first, id: 'own', senderId: demo.user.id };
          render([first, second, own]);
          expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
          expect(scroll.scrollTop).toBe(800);
          act(() => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
          expect(scroll.scrollTop).toBe(1200);
          expect(host.querySelector('.new-message-pill')).toBeNull();
          render([first, second, own, { ...first, id: 'third' }]);
          expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
          // 重开跟随不打断已经保留的阅读位置，回到底部后再开始跟随。
          settings.value = { autoFollowLatestMessages: true };
          render([first, second, own, { ...first, id: 'third' }]);
          expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
          act(() => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
          render([first, second, own, { ...first, id: 'fourth' }]);
          expect(host.querySelector('.new-message-pill')).toBeNull();
        } else {
          expect(host.querySelector('.new-message-pill')).toBeNull();
          act(() => {
            scroll.scrollTop = 100;
            scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          render([first, second, { ...first, id: 'third' }]);
          expect(scroll.scrollTop).toBe(100);
          expect(host.querySelector('.new-message-pill')?.textContent).toContain('1条新消息');
        }
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
  it.each(['direct', 'group'])(
    '%s 向下浏览复用底部按钮及预览，反向、到达底部和切换会话时收起，开关不影响新消息提醒',
    (kind) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      const demo = createTemplateDemoData();
      const conversation = demo.conversations.find((item) => item.type === kind)!;
      const read = vi.fn();
      const preview = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const first = {
        ...demo.messages[0]!,
        id: 'first',
        conversationId: conversation.id,
        senderId: 'peer',
      };
      const props = {
        user: demo.user,
        conversation,
        messages: [first],
        initialReadingPosition: { scrollTop: 500 },
        onPreviewLatest: preview,
        onReadCurrentConversation: read,
        draft: '',
      };
      const render = (next = {}) =>
        act(() => root.render(createElement(ChatPane, { ...props, ...next })));
      try {
        render();
        const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
        Object.defineProperties(scroll, {
          scrollHeight: { configurable: true, value: 2000 },
          clientHeight: { configurable: true, value: 400 },
        });
        const move = (top: number) =>
          act(() => {
            scroll.scrollTop = top;
            scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
        const pill = () => host.querySelector('.new-message-pill');
        expect(pill()).toBeNull();
        move(400);
        expect(pill()).toBeNull();
        move(600);
        expect(pill()).not.toBeNull();
        expect(pill()?.textContent).not.toContain('新消息');
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="预览最新消息"]')!.click());
        expect(preview).toHaveBeenCalledWith(conversation);
        expect(scroll.scrollTop).toBe(600);
        expect(read).not.toHaveBeenCalled();
        move(550);
        expect(pill()).toBeNull();
        move(700);
        settings.value = { showScrollToBottomButton: false };
        render();
        expect(pill()).toBeNull();
        settings.value = { showScrollToBottomButton: true };
        render();
        expect(pill()).not.toBeNull();
        move(1600);
        expect(pill()).toBeNull();
        move(500);
        move(600);
        act(() => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
        expect(pill()).toBeNull();
        expect(read).toHaveBeenCalledWith(conversation);
        move(500);
        settings.value = { showScrollToBottomButton: false };
        const own = { ...first, id: 'own', senderId: demo.user.id };
        render({ messages: [first, own] });
        expect(pill()).toBeNull();
        render({ messages: [first, own, { ...first, id: 'new' }, { ...own, id: 'own-2' }] });
        expect(pill()?.textContent).toContain('1条新消息');
        move(400);
        expect(pill()?.textContent).toContain('1条新消息');
        render({ conversation: { ...conversation, id: 'other' } });
        expect(pill()).toBeNull();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
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
        expect(button?.textContent).not.toContain('条新消息');
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
      expect(button.getAttribute('aria-label')).toBe(
        sender === 'self' ? '预览最新消息' : '预览新消息',
      );
      act(() => button.click());
      expect(preview).toHaveBeenCalledOnce();
      expect(preview).toHaveBeenCalledWith(conversation);
      expect(scroll.scrollTop).toBe(100);
      const pillText = host.querySelector('.new-message-pill')?.textContent ?? '';
      if (sender === 'self') expect(pillText).not.toContain('条新消息');
      else expect(pillText).toContain('1条新消息');
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

  it('历史窗口只统计入站未读增量，自己发送不计数，定位失败保留重试入口', async () => {
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
      conversation: { ...conversation, unreadCount: 0 },
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
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      Object.defineProperties(scroll, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 400 },
      });
      act(() => {
        scroll.scrollTop = 800;
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      // 历史页末尾仍不是会话底部；没有新消息时也能回最新窗口，失败保留入口。
      expect(host.querySelector('.new-message-bottom')).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('.new-message-bottom')!.click());
      expect(jump).toHaveBeenCalledOnce();
      expect(host.querySelector('.new-message-bottom')).not.toBeNull();
      expect(read).not.toHaveBeenCalled();
      jump.mockClear();
      // 自己发送推进会话序号，但不会增加入站未读数。
      act(() =>
        root.render(createElement(ChatPane, { ...props, latestMessageSeq: '9007199254740994' })),
      );
      expect(host.querySelector('.new-message-pill')?.textContent).not.toContain('条新消息');
      props.conversation = { ...conversation, unreadCount: 2 };
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
      expect(read).toHaveBeenCalledWith(props.conversation);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
