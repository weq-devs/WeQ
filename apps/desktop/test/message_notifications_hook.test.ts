import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageNotifications } from '../src/renderer/src/hooks/useMessageNotifications';
import type { NewMessagesWire } from '../src/main/ipc/routers/account';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

const f = vi.hoisted(() => ({
  web: false,
  values: { messageNotifications: false, applicationBadge: true, privacyMode: false },
  locked: false,
  receive: undefined as undefined | ((batch: NewMessagesWire) => void),
  notify: vi.fn(async () => true),
  browserNotify: vi.fn(() => true),
  badge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/browserNotifications', () => ({
  WEB_NOTICE_OPEN: 'weq:notice-open',
  browserNoticeChannel: () => ({ show: f.browserNotify, close() {} }),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
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
  f.values.messageNotifications = false;
  f.values.applicationBadge = true;
  f.values.privacyMode = false;
  f.locked = false;
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
  f.values.messageNotifications = true;
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
        web ? { target: { seq: '20', kind: 'group', conv: '10003' } } : { seq: '20' },
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
  f.values.messageNotifications = true;
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
it('发送者解析期间锁定后不泄露群名、发送者或正文', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.values.messageNotifications = true;
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
  f.values.messageNotifications = true;
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
    f.values.messageNotifications = true;
    let finish!: (name: string) => void;
    const resolveGroupSenderName = () => new Promise<string>((resolve) => (finish = resolve));
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe, { resolveGroupSenderName })));
    await act(async () => f.receive?.(batch('28', { kind: 'group', conv: '10003' })));
    try {
      if (state === 'unmount') await act(async () => root.unmount());
      else {
        if (state === 'disabled') f.values.messageNotifications = false;
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
  vi.spyOn(Document.prototype, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
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

it('乱序批次与缺失序号不改变第一条可定位消息的目标', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.values.messageNotifications = true;
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
