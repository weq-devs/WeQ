import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatRecordsModal } from '../src/renderer/src/components/search/ChatRecordsModal';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

const nativeReads = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', async () => {
  const stub = await import('./browser/clone-conversation.stub');
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        key === 'query' || key === 'mutate'
          ? (input: unknown) => {
              return Promise.resolve(nativeReads(path.join('.'), input) ?? { items: [], total: 0 });
            }
          : proxy([...path, String(key)]),
    });
  return { trpc: stub.trpc, client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  nativeReads.mockReset();
  vi.useRealTimers();
});

it('服务号搜索显示候选截断提示，消息定位保留服务号和消息身份', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const jump = vi.fn();
  const hit = {
    category: 'chatRecord' as const,
    source: 'buddy' as const,
    partition: '90001',
    targetUid: 'service:90001',
    targetUin: '',
    name: '合成服务号',
    count: 1,
  };
  nativeReads.mockImplementation((path: string) =>
    path === 'account.searchConversationRecords'
      ? {
          items: [
            {
              msgId: 'm1',
              msgSeq: '1',
              senderUid: 'service-sender',
              senderUin: '',
              senderName: '',
              sendTime: '1',
              content: '合成正文',
            },
          ],
          total: 1,
          limited: true,
        }
      : path === 'account.searchMore'
        ? { category: 'chatRecord', items: [hit], total: 1, hasMore: false }
        : undefined,
  );
  try {
    await act(async () =>
      root.render(
        h(ChatRecordsModal, {
          initialKeyword: '合成',
          initialHit: hit,
          onClose: vi.fn(),
          onJumpMessage: jump,
        }),
      ),
    );
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(document.body.textContent).toContain('本轮候选已显示完');
    expect(document.body.textContent).not.toContain('没有更多了');
    const message = document.querySelector<HTMLButtonElement>('.weq-chatrecords-msg')!;
    act(() => message.click());
    expect(jump).toHaveBeenCalledWith({
      source: 'buddy',
      targetUid: 'service:90001',
      msgSeq: '1',
      msgId: 'm1',
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('克隆复用普通搜索窗，分页显示但按完整匹配身份导出，不查询原生 QQ 记录', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const user = cloneChatUser('self', '我', '10000');
  const peer = cloneChatUser('peer', '合成好友', '20001', true);
  const conversation = cloneChatConversation({
    target: { kind: 'persona', ownerId: 'peer', sessionId: 's' },
    viewId: 'virtual:clone:search',
    name: peer.displayName,
    peer,
  });
  const messages = cloneChatMessages(
    Array.from({ length: 61 }, (_, index) => ({
      id: `row-${index}`,
      text: `合成记录 ${index}`,
      ts: index * 1000,
    })),
    conversation.id,
    () => peer,
  );
  const close = vi.fn();
  function Probe() {
    return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
  }
  try {
    await act(async () =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(ChatRecordsModal, {
            fixed: true,
            initialKeyword: '合成',
            initialHit: {
              category: 'chatRecord',
              source: 'buddy',
              partition: conversation.id,
              targetUid: conversation.id,
              targetUin: '',
              name: peer.displayName,
              count: messages.length,
            },
            localSource: { conversation, messages, user, onJump: vi.fn() },
            onClose: close,
            onJumpMessage: vi.fn(),
          }),
          h(Probe),
        ),
      ),
    );
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(30);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="消息类型"]')?.disabled).toBe(
      true,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="导出筛选结果"]')!.click(),
    );
    const exported = JSON.parse(host.querySelector('output')!.textContent!);
    expect(exported.owner).toEqual({
      kind: 'clone-messages',
      container: JSON.stringify(['persona', 'peer', 's']),
    });
    expect(exported.scope.ids).toEqual(messages.map((message) => message.id));
    expect(close).toHaveBeenCalledOnce();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('.weq-chatrecords-msgs > .weq-action-soft')!
        .click(),
    );
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(60);
    expect(nativeReads).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
