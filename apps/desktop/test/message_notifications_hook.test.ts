import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import { useMessageNotifications } from '../src/renderer/src/hooks/useMessageNotifications';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import type { NewMessagesWire } from '../src/main/ipc/routers/account';
import type { NotificationScope } from '@weq/service/notification-settings';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

const f = vi.hoisted(() => ({
  web: false,
  values: { messageNotifications: false, applicationBadge: true, privacyMode: false },
  locked: false,
  replyScope: undefined as NotificationScope | undefined,
  receive: undefined as undefined | ((batch: NewMessagesWire) => void),
  notify: vi.fn(async (_input: { conv: string; reasons: string[] }) => true),
  browserNotify: vi.fn(() => true),
  badge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
}));

function setMessageNotifications(enabled: boolean) {
  f.values.messageNotifications = enabled;
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy
      .getState()
      .setEvents(
        Object.fromEntries(
          Object.keys(events).map((event) => [event, { banner: false, system: enabled }]),
        ) as typeof events,
      ),
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setMessageNotifications(false);
});
vi.mock('../src/renderer/src/lib/browserNotifications', () => ({
  WEB_NOTICE_OPEN: 'weq:notice-open',
  browserNoticeChannel: () => ({ show: f.browserNotify, close() {} }),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return f.web;
  },
}));
vi.mock('../src/renderer/src/lib/target.shared', () => ({
  get IS_WEB() {
    return f.web;
  },
}));
vi.mock('../src/renderer/src/state/lock', () => ({
  useAppLock: (select: (state: { locked: boolean }) => unknown) => select(f),
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  useClientPreferences: () => 0,
  preferenceValue: (key: keyof typeof f.values) => f.values[key],
  accountBinding: () => ({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' }),
  isAccountStateReady: () => true,
  sharedAccountRecords: () => ({ replyMe: f.replyScope }),
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
  f.web = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else Reflect.deleteProperty(document, 'visibilityState');
  setMessageNotifications(false);
  f.values.applicationBadge = true;
  f.values.privacyMode = false;
  f.locked = false;
  f.replyScope = undefined;
  f.receive = undefined;
  f.notify.mockClear();
  f.browserNotify.mockClear();
  f.badge.mockClear();
  f.unsubscribe.mockClear();
});
it('Web 角标复用平台计数，退出账号工作区时清除', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.web = true;
  const setAppBadge = vi.fn(async () => undefined),
    clearAppBadge = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
    expect(f.badge).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
  expect(clearAppBadge).toHaveBeenCalledOnce();
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
it.each([false, true])('群通知保留群名并显示最后一条消息的发送者（Web=%s）', async (web) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.web = web;
  setMessageNotifications(true);
  const resolveGroupSenderName = vi.fn(async () => '本地群名片');
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    const first = batch('20', { kind: 'group', conv: '10003', senderUid: 'first' });
    const last = batch('21', { kind: 'group', conv: '10003', senderUid: 'last' });
    await act(async () =>
      f.receive?.({ ...first, messages: [...first.messages, ...last.messages] }),
    );
    expect(resolveGroupSenderName).toHaveBeenCalledOnce();
    expect(resolveGroupSenderName).toHaveBeenCalledWith(last.messages[0]);
    expect(web ? f.browserNotify : f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '测试群',
        body: '本地群名片：消息正文\n另有 1 条消息',
      }),
    );
    expect(web ? f.browserNotify : f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining(
        web
          ? { target: { seq: '20', msgId: '20', kind: 'group', conv: '10003' } }
          : { seq: '20', anchorId: '20', messageId: '21' },
      ),
    );
    await act(async () => f.receive?.(batch('22')));
    expect(web ? f.browserNotify : f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '测试联系人', body: '消息正文' }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it('群发送者资料缺失时回退 QQ 号或 UID，空消息仍保留发送者', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setMessageNotifications(true);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => f.receive?.(batch('23', { kind: 'group', conv: '10003' })));
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ body: '10002：消息正文' }));
    await act(async () =>
      f.receive?.(batch('24', { kind: 'group', conv: '10003', senderUin: '0', elements: [] })),
    );
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'peer：[消息]' }));
  } finally {
    await act(async () => root.unmount());
  }
});

it('乱序批次与缺失序号不改变第一条可定位消息的目标', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setMessageNotifications(true);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    const invalid = batch('missing-sequence', { msgSeq: '0' });
    const latest = batch('51');
    const first = batch('50');
    await act(async () =>
      f.receive?.({
        ...first,
        messages: [...invalid.messages, ...latest.messages, ...first.messages],
      }),
    );
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ conv: 'peer', seq: '50' }));
  } finally {
    await act(async () => root.unmount());
  }
});

it('系统仅提醒 @我而横幅提醒普通消息时，各渠道定位自己的首个来源', async () => {
  const events = useNotificationPolicy.getState().events;
  const next = Object.fromEntries(
    Object.keys(events).map((event) => [event, { banner: false, system: false }]),
  ) as typeof events;
  next.groupMessage.banner = true;
  next.mentionMe.system = true;
  act(() => useNotificationPolicy.getState().setEvents(next));
  const root = createRoot(document.createElement('div'));
  const opened = vi.fn();
  window.addEventListener('weq:notice-open', opened);
  try {
    const groups = conversations.map((conversation) =>
      conversation.id === '10003'
        ? {
            ...conversation,
            highlights: [{ kind: 'atMe' as const, rawKind: 0, senderUid: 'peer', msgSeq: '61' }],
          }
        : conversation,
    );
    await act(async () => root.render(createElement(Probe, { conversations: groups })));
    const ordinary = batch('60', { kind: 'group', conv: '10003' });
    const mention = batch('61', { kind: 'group', conv: '10003' });
    await act(async () =>
      f.receive?.({ ...mention, messages: [...ordinary.messages, ...mention.messages] }),
    );
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ conv: '10003', seq: '61', anchorId: '61' }),
    );
    act(() => useToast.getState().toasts.at(-1)!.action!.run());
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          target: { kind: 'group', conv: '10003', seq: '60', msgId: '60' },
        }),
      }),
    );
  } finally {
    window.removeEventListener('weq:notice-open', opened);
    await act(async () => root.unmount());
  }
});

it.each([
  { scope: undefined, expected: ['10003', '10004', '10005'] },
  { scope: { mode: 'nonGroupAssistant', targets: [] }, expected: ['10003', '10005'] },
  { scope: { mode: 'nonMuted', targets: [] }, expected: ['10005'] },
  { scope: { mode: 'selected', targets: ['group:10004'] }, expected: ['10004'] },
] satisfies { scope: NotificationScope | undefined; expected: string[] }[])(
  '按 $scope 筛选回复，免打扰会话的普通消息保持静默',
  async ({ scope, expected }) => {
    f.replyScope = scope;
    const events = useNotificationPolicy.getState().events;
    act(() =>
      useNotificationPolicy.getState().setEvents({
        ...events,
        groupMessage: { banner: false, system: true },
        replyMe: { banner: false, system: true },
      }),
    );
    const root = createRoot(document.createElement('div'));
    const group = conversations.find((row) => row.type === 'group')!;
    try {
      await act(async () =>
        root.render(
          createElement(Probe, {
            conversations: [...conversations, { ...group, id: '10004' }, { ...group, id: '10005' }],
            preferences: { '10003': { muted: true } } as Options['preferences'],
            groupAssistantIds: new Set(['10004']),
          }),
        ),
      );
      await act(async () => {
        f.receive?.(batch('70', { kind: 'group', conv: '10003' }));
        f.receive?.(batch('71', { kind: 'group', conv: '10004' }));
        expect(f.notify).not.toHaveBeenCalled();
        // 模拟引用消息先于 QQ 未读标记到达。
        for (const conv of ['10003', '10004', '10005']) {
          f.receive?.(
            batch('72', {
              kind: 'group',
              conv,
              elements: [{ type: 'reply', data: { origSenderUid: 'self' } }],
            }),
          );
        }
      });
      const replies = f.notify.mock.calls
        .map(([input]) => input)
        .filter((input) => input.reasons.includes('replyMe'));
      expect(replies.map((input) => input.conv)).toEqual(expected);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
it('发送者解析期间锁定后不泄露群名、发送者或正文', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setMessageNotifications(true);
  let finish!: (name: string) => void;
  const resolveGroupSenderName = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    await act(async () => f.receive?.(batch('25', { kind: 'group', conv: '10003' })));
    f.locked = true;
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    await act(async () => finish('群名片'));
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'WeQ', body: '收到新消息', private: true }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it('发送者解析失败仍显示消息，长名称和正文不超过原生通知限制', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setMessageNotifications(true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const resolveGroupSenderName = vi.fn(async (): Promise<string> => {
    throw new Error('本地资料不可读');
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    await act(async () => f.receive?.(batch('26', { kind: 'group', conv: '10003' })));
    expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({ body: '10002：消息正文' }));
    expect(warning).toHaveBeenCalledOnce();
    resolveGroupSenderName.mockImplementation(async () => '名'.repeat(1000));
    await act(async () =>
      f.receive?.(
        batch('27', {
          kind: 'group',
          conv: '10003',
          elements: [{ type: 'text', data: { textContent: '文'.repeat(3000) } }],
        }),
      ),
    );
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: `${'名'.repeat(256)}：${'文'.repeat(1700)}` }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it.each(['unmount', 'reading', 'disabled'])(
  '发送者查询未完成时 %s，不再弹出旧通知',
  async (state) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(Document.prototype, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    setMessageNotifications(true);
    let finish!: (name: string) => void;
    const resolveGroupSenderName = () => new Promise<string>((resolve) => (finish = resolve));
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    await act(async () => f.receive?.(batch('28', { kind: 'group', conv: '10003' })));
    try {
      if (state === 'unmount') await act(async () => root.unmount());
      else {
        if (state === 'disabled') setMessageNotifications(false);
        await act(async () =>
          root.render(
            createElement(Probe, {
              resolveGroupSenderName,
              foregroundConversation: state === 'reading' ? '10003' : undefined,
            }),
          ),
        );
      }
      await act(async () => finish('旧账号群名片'));
      expect(f.notify).not.toHaveBeenCalled();
    } finally {
      if (state !== 'unmount') await act(async () => root.unmount());
    }
  },
);
it('消息渠道全部关闭时不订阅，角标使用现成计数，开关互不影响', async () => {
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
  vi.spyOn(Document.prototype, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  setMessageNotifications(true);
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
