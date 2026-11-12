import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageNotifications } from '../src/renderer/src/hooks/useMessageNotifications';
import type { NewMessagesWire } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  values: { messageNotifications: false, applicationBadge: true, privacyMode: false },
  locked: false,
  receive: undefined as undefined | ((batch: NewMessagesWire) => void),
  notify: vi.fn(async () => true),
  badge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: false }));
vi.mock('../src/renderer/src/state/lock', () => ({
  useAppLock: (select: (state: { locked: boolean }) => unknown) => select(f),
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  useClientPreferences: () => 0,
  preferenceValue: (key: keyof typeof f.values) => f.values[key],
  accountBinding: () => ({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      onNewMessages: {
        subscribe: (_: unknown, callbacks: { onData(batch: NewMessagesWire): void }) => {
          f.receive = callbacks.onData;
          return { unsubscribe: f.unsubscribe };
        },
      },
      messageNotifications: {
        notify: { mutate: f.notify },
        badge: { mutate: f.badge },
        consume: { mutate: async () => null },
        onClick: { subscribe: () => ({ unsubscribe() {} }) },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  f.values.messageNotifications = false;
  f.values.applicationBadge = true;
  f.values.privacyMode = false;
  f.receive = undefined;
  f.notify.mockClear();
  f.badge.mockClear();
  f.unsubscribe.mockClear();
});
type Options = Parameters<typeof useMessageNotifications>[0];
const conversations = [
  { id: 'peer', type: 'direct', otherUser: { displayName: '测试联系人' } },
  { id: '10003', type: 'group', group: { name: '测试群' } },
] as unknown as Options['conversations'];
function Probe(props: Partial<Options>) {
  useMessageNotifications({
    selfUin: '10001',
    selfUid: 'self',
    conversations,
    preferences: {},
    badgeCount: 7,
    ...props,
  });
  return null;
}
const batch = (id = '1', patch = {}) =>
  ({
    accountUin: '10001',
    configId: 'fixture',
    observedAt: Date.now(),
    messages: [
      {
        kind: 'c2c',
        conv: 'peer',
        msgId: id,
        msgSeq: id,
        senderUid: 'peer',
        senderUin: '10002',
        sendTime: String(Math.floor(Date.now() / 1000)),
        elements: [{ type: 'text', data: { textContent: '消息正文' } }],
        ...patch,
      },
    ],
  }) as unknown as NewMessagesWire;
it('默认不开实时订阅，角标使用现成计数，开关互不影响', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(f.receive).toBeUndefined();
    expect(f.badge).toHaveBeenLastCalledWith(expect.objectContaining({ count: 7 }));
    f.values.applicationBadge = false;
    await act(async () => root.render(createElement(Probe, { badgeCount: 10 })));
    expect(f.badge).toHaveBeenLastCalledWith(expect.objectContaining({ count: 0 }));
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
it('去重、历史、免打扰、群助手、前台阅读与隐私状态共同约束通知', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  f.values.messageNotifications = true;
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      f.receive?.(batch());
      f.receive?.(batch());
      f.receive?.(batch('2', { sendTime: '1' }));
    });
    expect(f.notify).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(Probe, { foregroundConversation: 'peer' })));
    await act(async () => f.receive?.(batch('3')));
    expect(f.notify).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(
        createElement(Probe, {
          preferences: { peer: { muted: true } } as Options['preferences'],
          groupAssistantIds: new Set(['10003']),
        }),
      ),
    );
    await act(async () => {
      f.receive?.(batch('4'));
      f.receive?.(batch('5', { kind: 'group', conv: '10003' }));
    });
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.values.privacyMode = true;
    await act(async () => root.render(createElement(Probe)));
    await act(async () => f.receive?.(batch('6')));
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'WeQ', body: '收到新消息', private: true }),
    );
  } finally {
    await act(async () => root.unmount());
  }
  expect(f.unsubscribe).toHaveBeenCalledOnce();
});
