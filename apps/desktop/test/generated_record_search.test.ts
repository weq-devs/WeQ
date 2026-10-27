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
              nativeReads(path.join('.'), input);
              return Promise.resolve({ items: [], total: 0 });
            }
          : proxy([...path, String(key)]),
    });
  return { trpc: stub.trpc, client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
