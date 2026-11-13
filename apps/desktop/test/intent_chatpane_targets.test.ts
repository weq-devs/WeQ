import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import { useDialog } from '../src/renderer/src/components/Dialog';

const fixture = vi.hoisted(() => ({
  provider: {} as {
    latestMessageId?: string | null;
    latestPeerMsgId?: string | null;
    latestSelfMessageIds?: readonly string[];
    roamingMessageKey?: string;
    manualPendingMessageIds?: ReadonlySet<string>;
  },
  bar: {} as { replyTargetId?: string | null },
  enabled: false,
  list: vi.fn(async (): Promise<Array<{ msgId: string }>> => []),
  analyze: vi.fn<(input: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  IntentSenseProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    latestMessageId?: string | null;
    latestPeerMsgId?: string | null;
    latestSelfMessageIds?: readonly string[];
    roamingMessageKey?: string;
    manualPendingMessageIds?: ReadonlySet<string>;
  }) => {
    fixture.provider = props;
    return children;
  },
  useIntentSenseStatus: () => ({ data: { enabled: fixture.enabled, analysisMode: 'manual' } }),
  useIntentSenseContext: () => null,
}));
vi.mock('../src/renderer/src/components/intentSense/IntentSuggestionBar', () => ({
  IntentSuggestionBar: (props: { replyTargetId?: string | null }) => {
    fixture.bar = props;
    return null;
  },
}));
vi.mock('../src/renderer/src/components/intentSense/MessageIntentSense', () => ({
  MessageIntentSense: () => null,
}));
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
  return {
    trpc: proxy(),
    client: {
      account: {
        intentSense: {
          analyzeMessage: { mutate: fixture.analyze },
          listMessageAnalyses: { query: fixture.list },
        },
      },
    },
  };
});
beforeEach(() => {
  fixture.enabled = false;
  fixture.list.mockReset().mockResolvedValue([]);
  fixture.analyze.mockReset().mockResolvedValue(null);
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['group', 'direct'] as const)(
  '%s 媒体消息的意图感知置灰，私聊不显示贴表情',
  async (type) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.enabled = true;
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((row) => row.type === type)!;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages: [
              {
                ...demo.messages[0]!,
                conversationId: conversation.id,
                body: '[图片]',
                qqElements: [{ type: 'pic', data: {} }],
              },
            ],
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      await act(async () =>
        host
          .querySelector('.message-bubble')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
      // 纯媒体消息没有可分析的文字，入口不再显示灰按钮，而是直接不出现。
      const menuButton = () =>
        [...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')].find(
          (button) => button.textContent === '意图感知',
        );
      expect(menuButton()).toBeUndefined();
      expect(fixture.analyze).not.toHaveBeenCalled();
      expect(Boolean(host.querySelector('.message-reaction-strip'))).toBe(type === 'group');
      // 换成有文字的消息后入口回来：可用、标题为「意图感知」，点击才发起分析。
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages: [
              {
                ...demo.messages[0]!,
                conversationId: conversation.id,
                body: '合成可分析文本',
                qqElements: undefined,
              },
            ],
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      await act(async () =>
        host
          .querySelector('.message-bubble')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
      const textButton = menuButton()!;
      expect(textButton.disabled).toBe(false);
      expect(textButton.title).toBe('意图感知');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each([
  { results: ['success'], tone: null, counts: '' },
  { results: ['empty'], tone: 'error', counts: '成功 0 条，失败 1 条' },
  { results: ['error'], tone: 'error', counts: '成功 0 条，失败 1 条' },
  { results: ['success', 'success'], tone: 'success', counts: '成功 2 条，失败 0 条' },
  { results: ['empty', 'error'], tone: 'error', counts: '成功 0 条，失败 2 条' },
  { results: ['success', 'error'], tone: 'warning', counts: '成功 1 条，失败 1 条' },
  { results: ['success', 'media'], tone: 'success', counts: '成功 1 条，失败 0 条，跳过 1 条' },
  { results: ['media', 'media'], tone: 'info', counts: '成功 0 条，失败 0 条，跳过 2 条' },
  { results: ['success'], cached: ['1'], tone: null, counts: '' },
  {
    results: ['success', 'success'],
    cached: ['1'],
    tone: 'success',
    counts: '成功 1 条，失败 0 条，跳过 1 条',
  },
  {
    results: ['success', 'success'],
    cached: ['1', '2'],
    confirm: true,
    tone: 'success',
    counts: '成功 2 条，失败 0 条',
  },
  { results: ['success', 'success'], cached: ['1', '2'], confirm: false, tone: null, counts: '' },
  {
    results: ['success', 'success'],
    progress: true,
    tone: 'success',
    counts: '成功 2 条，失败 0 条',
  },
])(
  '手动意图横幅按真实结果汇总：$results / $cached / $confirm',
  async ({ results, tone, counts, cached = [], confirm, progress }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.enabled = true;
    fixture.list.mockResolvedValue(cached.map((msgId) => ({ msgId })));
    const ask = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(confirm ?? false);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((row) => row.type === 'direct')!;
    const messages = results.map((result, index) => ({
      ...demo.messages[0]!,
      id: String(index + 1),
      msgSeq: String(index + 1),
      conversationId: conversation.id,
      body: result === 'media' ? '[图片]' : '合成文本',
      qqElements:
        result === 'media'
          ? [{ type: 'pic', data: {} }]
          : [{ type: 'text', data: { textContent: '合成文本' } }],
    }));
    let finish: (() => void) | undefined;
    fixture.analyze.mockImplementation(async (input) => {
      if (progress)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      const result = results[Number((input as { msgId: string }).msgId) - 1];
      if (result === 'error') throw new Error('合成模型请求失败');
      return result === 'success' ? { msgId: (input as { msgId: string }).msgId } : null;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(
            Fragment,
            null,
            h(ChatPane, {
              user: demo.user,
              conversation,
              messages,
              draft: '',
              onSend: vi.fn(),
              onBack: vi.fn(),
            }),
            h(ToastHost),
          ),
        ),
      );
      await act(async () =>
        host
          .querySelector<HTMLElement>('.message-bubble')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
      const menuButton = (label: string) =>
        [...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')].find(
          (button) => button.textContent === label,
        )!;
      if (results.length === 1) await act(async () => menuButton('意图感知').click());
      else {
        await act(async () => menuButton('多选').click());
        await act(async () =>
          host.querySelector<HTMLElement>('.message-line[data-message-id="2"]')!.click(),
        );
        await act(async () =>
          host.querySelector<HTMLButtonElement>('.selection-bar [aria-label="意图感知"]')!.click(),
        );
      }
      if (progress) {
        const initial = useToast.getState().toasts[0]!;
        expect(initial).toMatchObject({ loading: true, ttl: 0, dismissible: false });
        expect(initial.title).toContain('0/2');
        await act(async () => finish!());
        expect(useToast.getState().toasts[0]).toMatchObject({ id: initial.id, loading: true });
        expect(useToast.getState().toasts[0]!.title).toContain('1/2');
        await act(async () => finish!());
        expect(useToast.getState().toasts[0]).toMatchObject({
          id: initial.id,
          loading: false,
          dismissible: true,
        });
      }
      expect(fixture.analyze).toHaveBeenCalledTimes(
        confirm === false
          ? 0
          : results.filter(
              (result, index) =>
                result !== 'media' &&
                (results.length === 1 || confirm === true || !cached.includes(String(index + 1))),
            ).length,
      );
      expect(ask).toHaveBeenCalledTimes(confirm === undefined ? 0 : 1);
      if (results.length === 1) expect(fixture.list).not.toHaveBeenCalled();
      const toasts = useToast.getState().toasts;
      expect(toasts).toHaveLength(tone ? 1 : 0);
      if (tone) {
        expect(toasts[0]!.tone).toBe(tone);
        expect(toasts[0]!.detail).toContain(counts);
        expect(host.querySelector(`.weq-toast-${tone}`)).not.toBeNull();
        if (results.includes('error')) expect(toasts[0]!.detail).toContain('合成模型请求失败');
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each(['group', 'direct'] as const)(
  '%s 手动意图分析由真实右键与多选入口触发，只分析选中消息',
  async (type) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    fixture.enabled = true;
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((row) => row.type === type)!;
    const messages = ['1', '2'].map((id) => ({
      ...demo.messages[0]!,
      id,
      conversationId: conversation.id,
      body: '合成文本',
      qqElements: [{ type: 'text', data: { textContent: '合成文本' } }],
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages,
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      expect(fixture.analyze).not.toHaveBeenCalled();
      const bubble = host.querySelector<HTMLElement>('.message-bubble')!;
      await act(async () =>
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
        ),
      );
      const menuButton = [
        ...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button'),
      ].find((button) => button.textContent === '意图感知')!;
      expect(menuButton).toBeDefined();
      let finish!: (value: null) => void;
      fixture.analyze.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finish = resolve;
          }),
      );
      await act(async () => menuButton.click());
      expect([...(fixture.provider.manualPendingMessageIds ?? [])]).toEqual(['1']);
      expect(fixture.analyze).toHaveBeenLastCalledWith({
        kind: type === 'group' ? 'group' : 'c2c',
        conv: conversation.id,
        msgId: '1',
        manual: true,
      });
      await act(async () => finish(null));
      expect(fixture.provider.manualPendingMessageIds?.size ?? 0).toBe(0);
      await act(async () =>
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
        ),
      );
      const multi = [
        ...host.querySelectorAll<HTMLButtonElement>('.message-context-menu button'),
      ].find((button) => button.textContent === '多选')!;
      await act(async () => multi.click());
      let fail!: (error: Error) => void;
      fixture.analyze.mockImplementationOnce(
        () =>
          new Promise<null>((_resolve, reject) => {
            fail = reject;
          }),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('.selection-bar [aria-label="意图感知"]')!.click(),
      );
      expect([...(fixture.provider.manualPendingMessageIds ?? [])]).toEqual(['1']);
      await act(async () => fail(new Error('合成分析失败')));
      expect(fixture.provider.manualPendingMessageIds?.size ?? 0).toBe(0);
      expect(fixture.analyze).toHaveBeenCalledTimes(2);
      expect(
        fixture.analyze.mock.calls.every(([input]) => (input as { msgId: string }).msgId === '1'),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each(['group', 'direct'] as const)(
  '%s 聊天区把自己的真实消息传给分析，把回复目标置空；新对方消息再恢复',
  async (type) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const demo = createTemplateDemoData(),
      conversation = demo.conversations.find((row) => row.type === type)!;
    const user = { ...demo.user, id: 'self:10000', identityValue: '10000', uid: 'u_self' };
    const message = (id: string, senderId: string) => ({
      ...demo.messages[0]!,
      id,
      conversationId: conversation.id,
      senderId,
      body: '合成正文',
      qqElements: [{ type: 'text', data: { textContent: '合成正文' } }],
    });
    const peer = message('peer', 'u_peer'),
      own = message('own', 'u_self');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (messages: Array<ReturnType<typeof message>>) =>
      act(async () =>
        root.render(
          h(ChatPane, {
            user,
            conversation,
            messages,
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
    try {
      const ownBefore = message('own-before', '10000');
      await render([peer, ownBefore, own]);
      expect(fixture.provider.latestMessageId).toBe('own');
      expect(fixture.provider.latestSelfMessageIds).toEqual(['own', 'own-before']);
      expect(fixture.provider.latestPeerMsgId).toBeNull();
      expect(fixture.bar.replyTargetId).toBeNull();
      await render([peer, message('roaming:protocol:2:77', 'u_peer'), ownBefore, own]);
      expect(fixture.provider.roamingMessageKey).toBe('roaming:protocol:2:77');
      expect(fixture.provider.latestMessageId).toBe('own');
      const next = message('new-peer', 'u_peer');
      await render([peer, own, next]);
      expect(fixture.provider.latestMessageId).toBe('new-peer');
      expect(fixture.provider.latestSelfMessageIds).toEqual([]);
      expect(fixture.bar.replyTargetId).toBe('new-peer');
      await act(async () =>
        root.render(
          h(ChatPane, {
            user,
            conversation,
            messages: [peer, own, next, { ...own, id: 'optimistic', optimistic: 'sending' }],
            draft: '',
            onSend: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      );
      expect(fixture.provider.latestMessageId).toBe('new-peer');
      expect(fixture.bar.replyTargetId).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
