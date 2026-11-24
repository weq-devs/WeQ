import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import { useMessageNotifications } from '../src/renderer/src/hooks/useMessageNotifications';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import type { NewMessagesWire } from '../src/main/ipc/routers/account';
import type {
  NotificationScope,
  ScopedNotificationEvent,
} from '@weq/service/notification-settings';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

const f = vi.hoisted(() => ({
  web: false,
  values: { messageNotifications: false, applicationBadge: true, privacyMode: false },
  locked: false,
  scopes: {} as Partial<Record<ScopedNotificationEvent, NotificationScope>>,
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
  PREFERENCES_CHANGED: 'weq:test-preferences-changed',
  useClientPreferences: () => 0,
  preferenceValue: (key: keyof typeof f.values) => f.values[key],
  accountBinding: () => ({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' }),
  isAccountStateReady: () => true,
  sharedAccountRecords: () => f.scopes,
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
  f.scopes = {};
  f.receive = undefined;
  f.notify.mockClear();
  f.browserNotify.mockClear();
  f.badge.mockClear();
  f.unsubscribe.mockClear();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
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
it.each([false, true])('合并群通知的预览与点击目标来自同一条消息（Web=%s）', async (web) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.web = web;
  setMessageNotifications(true);
  const resolveGroupSenderName = vi.fn(async () => '本地群名片');
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    const first = batch('20', {
      kind: 'group',
      conv: '10003',
      senderUid: 'first',
      elements: [{ type: 'text', data: { textContent: '第一条正文' } }],
    });
    const last = batch('21', {
      kind: 'group',
      conv: '10003',
      senderUid: 'last',
      elements: [{ type: 'text', data: { textContent: '最后一条正文' } }],
    });
    await act(async () =>
      f.receive?.({ ...first, messages: [...last.messages, ...first.messages] }),
    );
    expect(resolveGroupSenderName).toHaveBeenCalledOnce();
    expect(resolveGroupSenderName).toHaveBeenCalledWith(first.messages[0]);
    expect(web ? f.browserNotify : f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '测试群 · 2 条新消息',
        body: '本地群名片：第一条正文',
      }),
    );
    expect(web ? f.browserNotify : f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining(
        web
          ? { target: { seq: '20', msgId: '20', kind: 'group', conv: '10003' } }
          : { seq: '20', anchorId: '20', messageId: '20' },
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
it('群发送者资料缺失时回退 QQ 号，不显示内部 UID 或占位符', async () => {
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
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: '群成员发来一条消息' }),
    );
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

it('合并横幅只在同账号、同数据源和同会话确认最后一条已读后收起', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      directMessage: { banner: true, system: false },
    }),
  );
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    const latest = batch('9007199254740993');
    const first = batch('9007199254740992');
    const store = useToast.getState();
    store.push({ title: '不相关的提醒', system: false });
    await act(async () =>
      f.receive?.({ ...latest, messages: [...latest.messages, ...first.messages] }),
    );
    const id = useToast.getState().toasts.at(-1)!.id;
    expect(useToast.getState().toasts).toHaveLength(2);
    const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
    const row = { chatType: 1, uid: 'peer', readSeq: latest.messages[0]!.msgSeq };
    store.dismissReadMessages({ ...binding, expectedAccountConfigId: 'backup' }, [row]);
    store.dismissReadMessages(binding, [{ ...row, chatType: 2 }]);
    store.dismissReadMessages(binding, [{ ...row, readError: true }]);
    store.dismissReadMessages(binding, [{ ...row, readSeq: first.messages[0]!.msgSeq }]);
    expect(useToast.getState().leaving).toEqual([]);
    store.dismissReadMessages(binding, [row]);
    expect(useToast.getState().leaving).toEqual([id]);
  } finally {
    await act(async () => root.unmount());
  }
});

it('群回复横幅不等待同批普通消息，逐条确认须覆盖横幅内全部回复', async () => {
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...useNotificationPolicy.getState().events,
      groupMessage: { banner: true, system: false },
      replyMe: { banner: true, system: false },
    }),
  );
  const root = createRoot(document.createElement('div'));
  const store = useToast.getState();
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
  const group = { kind: 'group', conv: '10003' } as const;
  const reply = (seq: string) =>
    batch(seq, { ...group, elements: [{ type: 'reply', data: { origSenderUid: 'self' } }] });
  try {
    await act(async () => root.render(createElement(Probe)));
    const first = reply('160');
    const last = reply('162');
    const ordinary = batch('163', group);
    await act(async () =>
      f.receive?.({
        ...last,
        messages: [...first.messages, ...last.messages, ...ordinary.messages],
      }),
    );
    const banner = useToast.getState().toasts.at(-1)!;
    expect(banner.event).toBe('replyMe');
    const row = { chatType: 2, uid: group.conv, readSeq: '159', viewedReplySeqs: ['162'] };
    store.dismissReadMessages(binding, [row]);
    store.dismissReadMessages({ ...binding, expectedAccountConfigId: 'backup' }, [
      { ...row, viewedReplySeqs: ['160', '162'] },
    ]);
    expect(useToast.getState().leaving).toEqual([]);
    store.dismissReadMessages(binding, [{ ...row, readSeq: '160' }]);
    expect(useToast.getState().leaving).toEqual([banner.id]);

    const next = reply('164');
    await act(async () =>
      f.receive?.({ ...next, messages: [...next.messages, ...batch('165', group).messages] }),
    );
    const nextBanner = useToast.getState().toasts.at(-1)!;
    store.dismissReadMessages(binding, [{ ...row, readSeq: '164', viewedReplySeqs: undefined }]);
    expect(useToast.getState().leaving).toContain(nextBanner.id);
  } finally {
    await act(async () => root.unmount());
  }
});

it('后来的普通消息不覆盖另一渠道的 @你预览和位置', async () => {
  const events = useNotificationPolicy.getState().events;
  const next = Object.fromEntries(
    Object.keys(events).map((event) => [event, { banner: false, system: false }]),
  ) as typeof events;
  next.groupMessage = { banner: true, system: true };
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
    const mention = batch('61', {
      kind: 'group',
      conv: '10003',
      elements: [
        { type: 'at', data: { atTargetUid: 'self', textContent: '@测试账号' } },
        { type: 'text', data: { textContent: ' 请确认报名' } },
      ],
    });
    const last = batch('62', { kind: 'group', conv: '10003' });
    await act(async () =>
      f.receive?.({
        ...mention,
        messages: [...ordinary.messages, ...mention.messages, ...last.messages],
      }),
    );
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conv: '10003',
        seq: '61',
        anchorId: '61',
        title: '@你 · 测试群',
        body: '10002：请确认报名',
      }),
    );
    expect(useToast.getState().toasts.at(-1)).toMatchObject({
      title: '测试群 · 3 条新消息',
      summary: '10002：消息正文',
    });
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

it('群关键词只在所选群的已开启渠道接管普通通知', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      groupMessage: { banner: true, system: true },
      keyword: { banner: false, system: true },
    }),
  );
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () =>
      f.receive?.(batch('85', { kind: 'group', conv: '10003', groupKeyword: true })),
    );
    expect(f.notify).not.toHaveBeenCalled();
    expect(useToast.getState().toasts.at(-1)).toMatchObject({ event: 'groupMessage' });
    f.scopes.keyword = { mode: 'selected', targets: ['group:10004'] };
    await act(async () =>
      f.receive?.(batch('86', { kind: 'group', conv: '10003', groupKeyword: true })),
    );
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ conv: '10003', reasons: ['groupMessage'] }),
    );
  } finally {
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
    f.scopes.replyMe = scope;
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
it('私聊引用和 QQ 回复标记都只走普通私聊通知', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      directMessage: { banner: true, system: true },
      replyMe: { banner: true, system: true },
    }),
  );
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        createElement(Probe, {
          conversations: [
            {
              ...conversations[0]!,
              highlights: [{ kind: 'replyMe', rawKind: 1002, senderUid: 'peer', msgSeq: '91' }],
            },
          ],
        }),
      ),
    );
    await act(async () => {
      f.receive?.(batch('90', { elements: [{ type: 'reply', data: { origSenderUid: 'self' } }] }));
      f.receive?.(batch('91'));
    });
    expect(f.notify.mock.calls.map(([input]) => input.reasons)).toEqual([
      ['directMessage'],
      ['directMessage'],
    ]);
    expect(useToast.getState().toasts.map(({ event }) => event)).toEqual([
      'directMessage',
      'directMessage',
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
it('特别关心默认提醒免打扰会话，仍遵循显式设置的范围', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      specialCare: { banner: true, system: true },
    }),
  );
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        createElement(Probe, {
          conversations: [
            {
              ...conversations[0]!,
              highlights: ['92', '93', '94'].map((msgSeq) => ({
                kind: 'specialCare' as const,
                rawKind: 1006,
                senderUid: 'peer',
                msgSeq,
              })),
            },
          ],
          preferences: { peer: { pinned: false, muted: true, blocked: false } },
        }),
      ),
    );
    await act(async () => f.receive?.(batch('92')));
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ conv: 'peer', reasons: ['specialCare'] }),
    );
    expect(useToast.getState().toasts.at(-1)).toMatchObject({ event: 'specialCare' });
    f.scopes.specialCare = { mode: 'nonMuted', targets: [] };
    await act(async () => f.receive?.(batch('93')));
    expect(f.notify).toHaveBeenCalledOnce();
    f.scopes.specialCare = { mode: 'selected', targets: ['c2c:peer'] };
    await act(async () => f.receive?.(batch('94')));
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ conv: 'peer', reasons: ['specialCare'] }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
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
      expect.objectContaining({
        body: expect.stringMatching(/^名+…：文+…$/u),
      }),
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

it.each([false, true])('普通代理提醒可先发，入库补齐时仍只通知一次（Web=%s）', async (web) => {
  f.web = web;
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      directMessage: { banner: false, system: true },
      specialCare: { banner: false, system: false },
    }),
  );
  const root = createRoot(document.createElement('div'));
  const identity = 'proxy:42:7:peer';
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () =>
      f.receive?.(
        batch('7', {
          live: true,
          msgSeq: '42',
          noticeIdentity: identity,
        }),
      ),
    );
    const notify = web ? f.browserNotify : f.notify;
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining(
        web
          ? { target: { kind: 'c2c', conv: 'peer', seq: '42', msgId: identity } }
          : { seq: '42', messageId: identity, anchorId: identity },
      ),
    );
    await act(async () =>
      f.receive?.(
        batch('123456', {
          msgSeq: '42',
          noticeIdentity: identity,
        }),
      ),
    );
    expect(notify).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it('代理正文到达时等待未确认的特别关心，落库后保留重点提醒', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      directMessage: { banner: false, system: true },
      specialCare: { banner: false, system: true },
    }),
  );
  const root = createRoot(document.createElement('div'));
  const identity = 'proxy:43:8:peer';
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () =>
      f.receive?.(
        batch('8', {
          live: true,
          msgSeq: '43',
          noticeIdentity: identity,
        }),
      ),
    );
    expect(f.notify).not.toHaveBeenCalled();
    const priority = conversations.map((item) =>
      item.id === 'peer'
        ? {
            ...item,
            highlights: [
              { kind: 'specialCare' as const, rawKind: 1006, senderUid: 'peer', msgSeq: '43' },
            ],
          }
        : item,
    );
    await act(async () => root.render(createElement(Probe, { conversations: priority })));
    await act(async () =>
      f.receive?.(
        batch('123457', {
          msgSeq: '43',
          noticeIdentity: identity,
        }),
      ),
    );
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '特别关心 · 测试联系人',
        reasons: ['specialCare'],
        anchorId: '123457',
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it('群提醒词优先级不清楚时不抢发普通通知', async () => {
  const events = useNotificationPolicy.getState().events;
  act(() =>
    useNotificationPolicy.getState().setEvents({
      ...events,
      groupMessage: { banner: false, system: true },
      specialCare: { banner: false, system: false },
      keyword: { banner: false, system: true },
    }),
  );
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    const group = { kind: 'group', conv: '10003', senderUid: 'peer', live: true };
    await act(async () =>
      f.receive?.(batch('50', { ...group, noticeIdentity: 'proxy:50:7:peer' })),
    );
    await act(async () =>
      f.receive?.(
        batch('51', {
          ...group,
          noticeIdentity: 'proxy:51:7:peer',
          keywordChecked: true,
          groupKeyword: true,
        }),
      ),
    );
    expect(f.notify).not.toHaveBeenCalled();
    await act(async () =>
      f.receive?.(
        batch('52', {
          ...group,
          noticeIdentity: 'proxy:52:7:peer',
          keywordChecked: true,
        }),
      ),
    );
    expect(f.notify).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
