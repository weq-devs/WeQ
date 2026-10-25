import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';
import {
  intentTimelineTargets,
  type IntentTimelineMessage,
} from '../src/renderer/src/lib/intentTimeline';

interface QueryInput {
  kind: 'group' | 'c2c';
  conv: string;
  replyAllowed: boolean;
  targetId?: string | null;
}
const fixture = vi.hoisted(() => ({
  status: { suggestionsEnabled: true, suggestAfterSelf: false, suggestionRevision: 0 },
  query: vi.fn<(input: QueryInput) => Promise<Array<{ text: string }>>>(),
  refresh: vi.fn(),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({ data: fixture.status }),
}));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    client: { account: { intentSense: { getSuggestions: { query: fixture.refresh } } } },
    trpc: {
      account: {
        intentSense: {
          getSuggestions: {
            useQuery: (
              input: QueryInput,
              options: {
                enabled: boolean;
                cacheTime: number;
                staleTime: number;
                retry: false;
                refetchOnWindowFocus: false;
              },
            ) =>
              useQuery({
                queryKey: ['suggestions', input],
                queryFn: () => fixture.query(input),
                ...options,
              }),
          },
        },
      },
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  '发送后推荐=%s：乐观占位、列表同步空档和过期空结果都不隐藏原候选',
  async (suggestAfterSelf) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    fixture.status.suggestAfterSelf = suggestAfterSelf;
    fixture.query.mockReset().mockResolvedValue([{ text: '原推荐' }]);
    const peer: IntentTimelineMessage = { id: 'peer', senderId: 'u_peer', body: '合成问题' };
    const own: IntentTimelineMessage = { id: 'own', senderId: 'u_self', body: '合成回复' };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onInsert = vi.fn();
    let update!: (messages: IntentTimelineMessage[]) => void;
    function Scene() {
      const [messages, setMessages] = useState<IntentTimelineMessage[]>([peer]);
      update = setMessages;
      const targets = intentTimelineTargets(messages, new Set(['u_self']), () => false);
      return h(IntentSuggestionBar, {
        kind: 'group',
        conv: 'fixture',
        replyTargetId: targets.latestPeerMsgId,
        latestMessageId: targets.latestSuggestionId,
        onInsert,
      });
    }
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    const text = () => host.querySelector('.weq-int-suggest-text')?.textContent;
    try {
      act(() => root.render(h(QueryClientProvider, { client: queryClient }, h(Scene))));
      await settle();
      expect(text()).toBe('原推荐');
      const track = host.querySelector('.weq-int-suggest-track');
      let finishOld!: (result: Array<{ text: string }>) => void;
      fixture.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      act(() => {
        void queryClient.invalidateQueries({ queryKey: ['suggestions'] });
      });
      await settle();
      act(() => update([peer, { ...own, id: 'local:pending', optimistic: 'sending' }]));
      await settle();
      expect(text()).toBe('原推荐');
      // 本地占位撤下，但数据库的新消息尚未回到 UI；服务端已看到自己发言，旧查询返回空。
      act(() => update([peer]));
      await settle();
      await act(async () => {
        finishOld([]);
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(text()).toBe('原推荐');
      expect(host.querySelector('.weq-int-suggest-track')).toBe(track);
      act(() => host.querySelector<HTMLButtonElement>('.weq-int-suggest-pill')!.click());
      expect(onInsert).toHaveBeenCalledWith('原推荐');
      fixture.query.mockImplementation(() => new Promise(() => {}));
      act(() => update([peer, own]));
      await settle();
      expect(text()).toBe('原推荐');
      fixture.query.mockResolvedValue([{ text: '新推荐' }]);
      act(() => update([peer, own, { ...peer, id: 'next-peer' }]));
      await settle();
      expect(text()).toBe('新推荐');
      expect(host.querySelector('.weq-int-suggest-track')).toBe(track);
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      host.remove();
    }
  },
);
