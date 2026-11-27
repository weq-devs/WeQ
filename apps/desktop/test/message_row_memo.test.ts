import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ShowMessageSeqContext,
  ShowMessageTimeContext,
} from '../src/renderer/src/components/MessageProvenance.shared';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { ChatMainContent } from '../src/renderer/src/im-template/template/chatMainContent';
import { createTemplateDemoData } from './support/templateDemoData';
import { messagePerformanceSnapshot } from '../src/renderer/src/lib/messagePerformance';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useStableCallback } from '../src/renderer/src/hooks/useStableCallback';
import { mergeRefreshedWindow } from '../src/renderer/src/lib/conversationRefresh';
import { messageGroups } from '../src/renderer/src/im-template/template/chatTimelineModel';
import type { Message } from '../src/renderer/src/im-template/template/types';

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
afterEach(() => vi.unstubAllGlobals());

it('连续分组纳入本地发送占位，仍按身份、时间与时间线分界拆组', () => {
  const row = (seq: number, patch: Partial<Message> = {}): Message => ({
    id: String(seq),
    msgSeq: String(seq),
    conversationId: 'fixture',
    senderId: 'sender-a',
    senderUid: 'uid-a',
    body: '合成消息',
    createdAt: '2026-11-20T23:59:59+08:00',
    ...patch,
  });
  const positions = (messages: Message[]) => [
    ...messageGroups(messages, {
      standalone: (message) => message.id === 'deleted',
      breakBefore: (_previous, message) => message.id === 'unread',
    }),
  ];
  expect(positions([row(1), row(2), row(3)])).toEqual(['first', 'middle', 'last']);
  expect(
    positions([
      row(1),
      row(2, { recall: { revokeUid: 'uid-a', sameSender: true, recallTs: 1795188000 } }),
      row(3),
    ]),
  ).toEqual(['first', 'middle', 'last']);
  expect(
    positions([
      row(1, { qqElements: [{ type: 'reply', data: {} }] }),
      row(2, { qqElements: [{ type: 'file', data: {} }] }),
      row(3, { qqElements: [{ type: 'reply', data: {} }] }),
    ]),
  ).toEqual(['first', 'middle', 'last']);
  expect(
    positions([
      row(1),
      row(2, { msgSeq: '', senderUid: undefined, optimistic: 'sending' }),
      row(3, { msgSeq: '', senderUid: undefined, optimistic: 'queued' }),
    ]),
  ).toEqual(['first', 'middle', 'last']);
  expect(
    positions([
      row(1, { optimistic: 'sent' }),
      row(2, { msgSeq: '', optimistic: 'failed' }),
      row(3, { msgSeq: '', optimistic: 'sent', optimisticRejected: true }),
    ]),
  ).toEqual(['first', 'middle', 'last']);
  for (const separated of [
    [row(1), row(2, { senderUid: 'uid-b' })],
    [row(1), row(2, { createdAt: '2026-11-21T00:00:00+08:00' })],
    [row(1), row(2, { createdAt: '2026-11-20T23:59:58+08:00' })],
    [row(1), row(2, { createdAt: '2026-11-20T23:54:59+08:00', optimistic: 'queued' })],
    [row(1, { createdAt: '2026-11-20T23:54:59+08:00' }), row(2)],
    [row(1), row(2, { id: 'unread' })],
    [row(1), row(2, { id: 'deleted' }), row(3)],
    [row(1), row(2, { qqElements: [{ type: 'grayTipRevoke', data: {} }] }), row(3)],
  ])
    expect(positions(separated)).toEqual(separated.map(() => undefined));
});

it('排队消息逐条收到 QQ 回声时，只有组首显示头像和元数据', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('matchMedia', (query: string) =>
    Object.assign(new EventTarget(), { matches: query === '(prefers-reduced-motion: reduce)' }),
  );
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const queued = [1, 2, 3].map(
    (id): Message => ({
      id: `local-${id}`,
      conversationId: conversation.id,
      senderId: demo.user.id,
      body: `消息 ${id}`,
      createdAt: `2026-11-20T23:00:00.${id}00+08:00`,
      optimistic: id === 1 ? 'sending' : 'queued',
    }),
  );
  const confirmed = queued.map(
    (message, index): Message => ({
      ...message,
      id: `qq-${index + 1}`,
      outgoingId: message.id,
      msgSeq: String(index + 11),
      createdAt: `2026-11-20T23:00:0${index + 1}+08:00`,
      optimistic: undefined,
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    user: demo.user,
    conversation,
    groupConsecutiveMessages: true,
    loading: false,
    draft: '',
    onSend: vi.fn(),
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  try {
    for (const messages of [
      queued,
      [confirmed[0]!, ...queued.slice(1)],
      [confirmed[0]!, { ...queued[1]!, optimistic: 'sent' as const, msgSeq: '12' }, queued[2]!],
      [...confirmed.slice(0, 2), { ...queued[2]!, optimistic: 'sending' as const }],
      confirmed,
    ]) {
      act(() =>
        root.render(
          h(
            ShowMessageTimeContext.Provider,
            { value: true },
            h(ShowMessageSeqContext.Provider, { value: true }, h(ChatPane, { ...props, messages })),
          ),
        ),
      );
      for (const [index, message] of messages.entries()) {
        const row = host.querySelector(`[data-message-id="${message.id}"]`)!;
        expect(row.textContent).toContain(message.body);
        expect(Boolean(row.querySelector('.weq-message-provenance')), message.id).toBe(index === 0);
        expect(Boolean(row.querySelector('.avatar')), message.id).toBe(index === 0);
      }
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('输入草稿不重画未变消息，编辑和前插只重画变化行', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const messages = [1, 2].map((id) => ({
    id: String(id),
    msgId: String(id),
    msgSeq: String(id + 1),
    conversationId: conversation.id,
    senderId: conversation.otherUser.id,
    body: `fixture ${id}`,
    createdAt: '2026-10-25T12:00:00Z',
  }));
  const props = {
    user: demo.user,
    conversation,
    messages,
    draft: '',
    loading: false,
    onSend: vi.fn(),
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(ChatPane, props)));
    const initial = messagePerformanceSnapshot().counters.rowRenders;
    act(() => root.render(h(ChatPane, { ...props, draft: 'new draft' })));
    expect(messagePerformanceSnapshot().counters.rowRenders).toBe(initial);
    const edited = [messages[0]!, { ...messages[1]!, body: 'edited' }];
    act(() =>
      root.render(
        h(ChatPane, {
          ...props,
          draft: 'new draft',
          messages: edited,
        }),
      ),
    );
    expect(messagePerformanceSnapshot().counters.rowRenders).toBe(initial + 1);
    const older = { ...messages[0]!, id: '0', msgId: '0', msgSeq: '1', body: 'older' };
    const prepended = mergeRefreshedWindow(edited, structuredClone([older, ...edited]), 500);
    act(() => root.render(h(ChatPane, { ...props, draft: 'new draft', messages: prepended })));
    expect(messagePerformanceSnapshot().counters.rowRenders).toBe(initial + 2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('前插同人发言时移动组头像，且只在缺口可见时拆组', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const rows = [1, 2, 3].map((id) => ({
    id: String(id),
    msgId: String(id),
    msgSeq: String(id),
    conversationId: conversation.id,
    senderId: conversation.otherUser.id,
    body: `消息 ${id}`,
    createdAt: '2026-11-20T23:00:00+08:00',
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (
    messages: Message[],
    overrides: Partial<Parameters<typeof ChatMainContent>[0]> = {},
  ) =>
    act(() =>
      root.render(
        h(ChatMainContent, {
          view: 'messages',
          user: demo.user,
          activeConversation: conversation,
          messages,
          loadingMessages: false,
          conversationPrefs: {},
          drafts: {},
          onBackContact: vi.fn(),
          onBackGroup: vi.fn(),
          onBackConversation: vi.fn(),
          ...overrides,
        }),
      ),
    );
  const line = (id: string) => host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
  const avatar = (id: string) => line(id).querySelector('.avatar');
  try {
    render(rows.slice(1));
    expect(avatar('3')).not.toBeNull();
    act(() =>
      acceptPreferences(
        { revision: 1, values: { groupConsecutiveMessages: true }, records: {} },
        false,
      ),
    );
    const old = line('2');
    expect(avatar('2')).not.toBeNull();
    expect(avatar('3')).toBeNull();
    render(rows);
    expect(line('2')).toBe(old);
    expect(avatar('1')).not.toBeNull();
    expect(avatar('2')).toBeNull();
    expect(avatar('3')).toBeNull();
    expect(line('2').textContent).toContain('消息 2');

    render([rows[0]!, rows[2]!]);
    expect(avatar('3')).toBeNull();
    expect(line('gap:1:3')).toBeNull();

    const jump = { missingJumpSeq: '2', onOpenGapMessages: vi.fn() };
    render([rows[0]!, rows[2]!], jump);
    expect(avatar('3')).not.toBeNull();
    expect(line('gap:1:3')).not.toBeNull();
    render([rows[0]!, rows[2]!], { ...jump, resolvedGapIds: new Set(['gap:1:3']) });
    expect(avatar('3')).toBeNull();
    expect(line('gap:1:3')).toBeNull();

    const multipleMissing = [rows[0]!, { ...rows[2]!, msgSeq: '4' }];
    render(multipleMissing);
    expect(avatar('3')).not.toBeNull();
    expect(line('gap:1:4')).not.toBeNull();
    render(multipleMissing, { resolvedGapIds: new Set(['gap:1:4']) });
    expect(avatar('3')).toBeNull();
    expect(line('gap:1:4')).toBeNull();
    act(() => acceptPreferences({ revision: 2, values: {}, records: {} }, false));
    expect(avatar('3')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    acceptPreferences({ revision: 2, values: {}, records: {} }, false);
    host.remove();
  }
});

it('行级回调引用稳定，但事件执行的是最新已提交的实现', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const values: string[] = [],
    callbacks: Array<unknown> = [];
  function Fixture({ name }: { name: string }) {
    const onClick = useStableCallback(() => values.push(name));
    callbacks.push(onClick);
    return h('button', { onClick }, 'event');
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  try {
    act(() => root.render(h(Fixture, { name: 'first' })));
    act(() => host.querySelector('button')!.click());
    act(() => root.render(h(Fixture, { name: 'second' })));
    act(() => host.querySelector('button')!.click());
    expect(callbacks[0]).toBe(callbacks[1]);
    expect(values).toEqual(['first', 'second']);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
