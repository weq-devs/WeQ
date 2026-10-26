import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { messagePerformanceSnapshot } from '../src/renderer/src/lib/messagePerformance';
import { useStableCallback } from '../src/renderer/src/hooks/useStableCallback';

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
it('输入草稿不重画未变消息，编辑只重画对应行', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const messages = [1, 2].map((id) => ({
    id: String(id),
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
    act(() =>
      root.render(
        h(ChatPane, {
          ...props,
          draft: 'new draft',
          messages: [messages[0]!, { ...messages[1]!, body: 'edited' }],
        }),
      ),
    );
    expect(messagePerformanceSnapshot().counters.rowRenders).toBe(initial + 1);
  } finally {
    act(() => root.unmount());
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
