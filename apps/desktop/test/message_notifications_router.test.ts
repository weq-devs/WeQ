// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { createMessageNotificationsRouter } from '../src/main/ipc/routers/message_notifications';
import type { WebNotice } from '../src/main/web/notices';
import {
  normalizeNotificationEvents,
  type NotificationEvents,
} from '@weq/service/notification-settings';
const f = vi.hoisted(() => ({
  values: { applicationBadge: true, messageNotifications: false, privacyMode: false },
  badge: vi.fn(() => true),
  notify: vi.fn((_notice: WebNotice, _onClick: () => void) => true),
  policy: undefined as NotificationEvents | undefined,
}));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({
    userConfig: { getSettings: () => ({ notificationEvents: f.policy }) },
  }),
}));
vi.mock('@weq/service', () => ({
  logRequest: (_source: string, _path: string, _type: string, run: () => unknown) => run(),
  getHost: () => ({ setApplicationBadge: f.badge, showMessageNotification: f.notify }),
}));
vi.mock('../src/main/ipc/routers/client_state', () => ({
  globalClientState: () => ({ snapshot: () => ({ values: f.values }) }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  f.values.applicationBadge = true;
  f.values.messageNotifications = false;
  f.values.privacyMode = false;
  f.policy = undefined;
});
it('私聊与群聊系统通知分别服从事件表，不再由旧总开关覆盖', async () => {
  const api = createMessageNotificationsRouter(() => {}).createCaller({});
  f.values.messageNotifications = true;
  f.policy = normalizeNotificationEvents(undefined);
  f.policy.directMessage.system = false;
  expect(
    await api.notify({
      ...binding,
      messageId: 'split-direct',
      kind: 'c2c',
      conv: 'peer',
      seq: '2',
      title: '名字',
      body: '正文',
      private: false,
    }),
  ).toBe(false);
  expect(
    await api.notify({
      ...binding,
      messageId: 'split-group',
      kind: 'group',
      conv: '20001',
      seq: '3',
      title: '群名',
      body: '正文',
      private: false,
    }),
  ).toBe(true);
  expect(f.notify).toHaveBeenCalledOnce();
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
it('私聊不能借用群友回复的系统通知开关', async () => {
  const api = createMessageNotificationsRouter(() => {}).createCaller({});
  const notice = {
    ...binding,
    messageId: 'private-reply',
    kind: 'c2c' as const,
    conv: 'peer',
    seq: '4',
    title: '名字',
    body: '正文',
    private: false,
  };
  f.policy = normalizeNotificationEvents(undefined);
  expect(await api.notify({ ...notice, reasons: ['replyMe'] })).toBe(false);
  expect(await api.notify({ ...notice, reasons: ['directMessage'] })).toBe(true);
  expect(f.notify).toHaveBeenCalledOnce();
});
it('原生桥复核共享开关、隐私和去重，关闭角标清零', async () => {
  const resolve = vi.fn();
  const api = createMessageNotificationsRouter(resolve).createCaller({});
  const notice = {
    ...binding,
    messageId: 'router-1',
    kind: 'c2c' as const,
    conv: 'peer',
    seq: '1',
    title: '名字',
    body: '正文',
    private: false,
  };
  expect(await api.notify(notice)).toBe(false);
  expect(f.notify).not.toHaveBeenCalled();
  f.values.messageNotifications = true;
  f.values.privacyMode = true;
  await api.notify(notice);
  await api.notify(notice);
  expect(f.notify).toHaveBeenCalledOnce();
  expect(f.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'WeQ', body: '收到新消息' }),
    expect.any(Function),
  );
  await api.badge({ ...binding, count: 8 });
  expect(f.badge).toHaveBeenLastCalledWith(8);
  f.values.applicationBadge = false;
  await api.badge({ ...binding, count: 8 });
  expect(f.badge).toHaveBeenLastCalledWith(0);
  expect(resolve).toHaveBeenCalledTimes(5);
});

it('代理提醒和落库后的提醒共用宿主去重，两端提交也只发一次', async () => {
  const api = createMessageNotificationsRouter(() => {});
  const first = api.createCaller({});
  const second = api.createCaller({});
  f.policy = normalizeNotificationEvents(undefined);
  const event = {
    ...binding,
    messageId: 'proxy:42:7:u_peer',
    anchorId: 'proxy:42:7:u_peer',
    kind: 'c2c' as const,
    conv: 'u_peer',
    seq: '42',
    title: '联系人',
    body: '同一条消息',
    private: false,
  };
  expect(await first.notify(event)).toBe(true);
  expect(await second.notify({ ...event, anchorId: '987654321' })).toBe(true);
  expect(f.notify).toHaveBeenCalledOnce();
  const [shownNotice, click] = f.notify.mock.calls[0]!;
  click();
  expect(shownNotice.target).toEqual({
    kind: 'c2c',
    conv: 'u_peer',
    seq: '42',
    msgId: event.anchorId,
  });
  expect(await first.consume(binding)).toEqual(shownNotice);
});
