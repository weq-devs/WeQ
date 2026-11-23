import { act, createElement, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageWindowState } from '../src/renderer/src/views/workspace/useMessageWindowState';
import {
  useConversationWindowSelection,
  useMessageReadSelection,
  useMessageWindowDescriptor,
  useConversationWindowEntry,
} from '../src/renderer/src/views/workspace/useConversationWindowRead';
import type { MessagePageStage } from '../src/shared/message_read';
import type { ChatMsgWire } from '../src/renderer/src/views/workspace/types';
import { conversationWindowKey } from '../src/renderer/src/lib/conversationWindowCache';
import { createTemplateDemoData } from './support/templateDemoData';

const f = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    conv: string;
    onData: (data: MessagePageStage<ChatMsgWire>) => void;
  }>,
  unsubscribe: vi.fn(),
  cancel: vi.fn(async () => {}),
  readRecovery: () => undefined,
  appliedRecovery: () => {},
  center: vi.fn(async (..._args: unknown[]) => false),
  listBefore: vi.fn(async () => []),
  listAfter: vi.fn(async () => []),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      latestPage: {
        subscribe: (
          input: { conv: string },
          callbacks: { onData: (data: MessagePageStage<ChatMsgWire>) => void },
        ) => {
          f.subscriptions.push({ conv: input.conv, ...callbacks });
          return { unsubscribe: f.unsubscribe };
        },
      },
      cancelMessageRead: { mutate: f.cancel },
      listBefore: { query: f.listBefore },
      listAfter: { query: f.listAfter },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useConversationRecoveryPosition', () => ({
  useConversationRecoveryPosition: () => ({ read: f.readRecovery, applied: f.appliedRecovery }),
}));

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  f.subscriptions = [];
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  const direct = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
  let configId = 'window-source';
  let conversation = { ...direct, id: 'u_first' };
  let resume = false;
  let current!: ReturnType<typeof useMessageWindowState>;
  function Probe() {
    const binding = { expectedAccountUin: '90001', expectedAccountConfigId: configId };
    const [, setVisibleConversationIds] = useState<readonly string[]>([]);
    const state = useMessageWindowState({
      messageScope: JSON.stringify(Object.values(binding)),
      binding,
      messageActivity: { enabled: false, revision: 0 },
      setVisibleConversationIds,
    });
    current = state;
    useConversationWindowSelection(state, {
      activeConversationId: conversation.id,
      selectedUid: conversation.id,
      isDirect: true,
      isGroup: false,
      selectedMessageWindowKey: conversationWindowKey(state.messageScope, 'c2c', conversation.id),
      messagesTabActive: true,
      resumeReadingPosition: resume,
      onScopeChange: useCallback(() => {}, []),
    });
    useMessageReadSelection(state, {
      selectedUid: conversation.id,
      isDirect: true,
      isGroup: false,
    });
    useMessageWindowDescriptor(state);
    useConversationWindowEntry(state, {
      selectedConversation: conversation,
      selectedUid: conversation.id,
      isDirect: true,
      isGroup: false,
      messagesTabActive: true,
      resumeReadingPosition: resume,
      centerWindowOnSeq: f.center,
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const queryClient = new QueryClient();
  const render = async (next?: { config?: string; conv?: string; resume?: boolean }) => {
    if (next?.config) configId = next.config;
    if (next?.conv) conversation = { ...direct, id: next.conv };
    if (next?.resume !== undefined) resume = next.resume;
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
      ),
    );
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await act(async () => root.unmount());
    queryClient.clear();
  };
  cleanups.push(dispose);
  await render();
  return {
    render,
    dispose,
    get current() {
      return current;
    },
  };
}
function stage(text: string): MessagePageStage<ChatMsgWire> {
  return {
    complete: true,
    reuseLocal: false,
    rows: [
      {
        msgId: text,
        msgSeq: '1',
        senderUid: 'u_peer',
        senderUin: '20001',
        sendTime: '1700000000',
        elements: [{ type: 'text', text }],
      },
    ],
  };
}

it('普通重绘不重启首屏读取、不取消窗口，控制器缓存与预取实例稳定', async () => {
  const c = await fixture();
  const { conversationWindows, firstPages, prefetchVisible } = c.current;
  await c.render();
  expect(f.subscriptions).toHaveLength(1);
  expect(f.cancel).not.toHaveBeenCalled();
  expect(c.current.conversationWindows).toBe(conversationWindows);
  expect(c.current.firstPages).toBe(firstPages);
  expect(c.current.prefetchVisible).toBe(prefetchVisible);
  await act(async () => f.subscriptions[0].onData(stage('首屏')));
  expect(c.current.loaded.map((row) => row.msgId)).toEqual(['首屏']);
  expect(c.current.messagesLoading).toBe(false);
});

it('换会话即时清掉旧正文，迟到首屏不能覆盖当前窗口', async () => {
  const c = await fixture();
  const first = f.subscriptions[0];
  await c.render({ conv: 'u_second' });
  const second = f.subscriptions.at(-1)!;
  await act(async () => first.onData(stage('旧会话')));
  expect(c.current.loaded).toEqual([]);
  await act(async () => second.onData(stage('新会话')));
  expect(c.current.loaded.map((row) => row.msgId)).toEqual(['新会话']);
});

it.each([
  { source: '带序号的历史消息', seq: '80' },
  { source: '刚发出的卡片', seq: undefined },
])('$source 的定位优先于迟到的续读设置，普通打开仍会续读', async ({ seq }) => {
  const c = await fixture();
  await act(async () => f.subscriptions[0].onData(stage('首屏')));
  const conv = 'u_second';
  const positionKey = conversationWindowKey(c.current.messageScope, 'c2c', conv);
  c.current.conversationWindows.setPosition(positionKey, { anchorSeq: '12', scrollTop: 100 });
  const target = { conv, kind: 'c2c' as const, seq, messageId: 'target' };
  const result = Promise.withResolvers<boolean>();
  f.center.mockReturnValueOnce(result.promise);
  c.current.pendingSearchJumpRef.current = target;
  await c.render({ conv });
  expect(f.center).toHaveBeenCalledWith(conv, 'c2c', seq, undefined, 'target');
  await c.render({ resume: true });
  expect(f.listBefore).not.toHaveBeenCalled();
  expect(c.current.messagesLoading).toBe(true);
  await act(async () => result.resolve(true));
  expect(c.current.messagesLoading).toBe(false);
  await c.render({ conv: 'u_first' });
  await c.render({ conv });
  expect(f.listBefore).toHaveBeenCalledWith(expect.objectContaining({ conv, beforeSeq: '13' }));
});

it('切换数据源废弃旧缓存、旧首屏和预取实例', async () => {
  const c = await fixture();
  const first = f.subscriptions[0];
  const firstPages = c.current.firstPages;
  await c.render({ config: 'second-source' });
  expect(c.current.firstPages).not.toBe(firstPages);
  await act(async () => first.onData(stage('旧数据源')));
  expect(c.current.loaded).toEqual([]);
  await act(async () => f.subscriptions.at(-1)!.onData(stage('新数据源')));
  expect(c.current.loaded.map((row) => row.msgId)).toEqual(['新数据源']);
});

it('卸载取消首屏订阅与读取，迟到结果不再交付', async () => {
  const c = await fixture();
  const first = f.subscriptions[0];
  const dispose = vi.spyOn(c.current.firstPages, 'dispose');
  await c.dispose();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.cancel).toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(c.current.messageScopeRef.current).toBe('');
  await act(async () => first.onData(stage('迟到的结果')));
  expect(c.current.loaded).toEqual([]);
});
