// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { createMessageNotificationsRouter } from '../src/main/ipc/routers/message_notifications';
import {
  normalizeNotificationEvents,
  type NotificationEvents,
} from '@weq/service/notification-settings';
const f = vi.hoisted(() => ({
  values: { applicationBadge: true, messageNotifications: false, privacyMode: false },
  badge: vi.fn(() => true),
  notify: vi.fn(() => true),
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
