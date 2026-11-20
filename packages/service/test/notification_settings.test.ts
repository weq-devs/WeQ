import { expect, it } from 'vitest';
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_EVENTS,
  normalizeNotificationEvents,
  notificationGroupState,
  normalizeNotificationScope,
} from '../src/common/notification_settings';
import { configFixture } from './support/user_config';
import { ClientStateStore } from '../src/bootstrap/client_state';
import { join } from 'node:path';
import { migrateSharedPreferences } from '../src/bootstrap/shared_preferences_migration';

it('普通群聊仅系统通知，@全体双渠道，撤回仅横幅', () => {
  expect(NOTIFICATION_GROUPS).toHaveLength(4);
  expect(NOTIFICATION_EVENTS).toHaveLength(24);
  expect(new Set(NOTIFICATION_EVENTS).size).toBe(NOTIFICATION_EVENTS.length);
  const values = normalizeNotificationEvents(undefined);
  expect(values.redPacket).toEqual({ banner: false, system: false });
  expect(values.recall).toEqual({ banner: true, system: false });
  for (const event of NOTIFICATION_GROUPS[0].events)
    expect(values[event]).toEqual({ banner: false, system: true });
  expect(values.mentionMe).toEqual({ banner: true, system: true });
  expect(values.replyMe).toEqual({ banner: true, system: true });
  expect(values.mentionAll).toEqual({ banner: true, system: true });
  expect(values.progress).toEqual({ banner: true, system: false });
  expect(values.taskComplete).toEqual({ banner: true, system: false });
  expect(values.taskFailure).toEqual({ banner: true, system: true });
  expect(NOTIFICATION_GROUPS.find((group) => group.id === 'app')?.events).toContain(
    'databaseDamage',
  );
  expect(values.databaseDamage).toEqual({ banner: true, system: false });
  expect(values.officialAnnouncement).toEqual({ banner: true, system: false });
});
it('数据库异常提醒继承旧关闭选择，新双渠道设置优先且保存重开保持独立', () => {
  expect(
    normalizeNotificationEvents(undefined, { suppressDbDamageReminder: true }).databaseDamage,
  ).toEqual({ banner: false, system: false });
  expect(
    normalizeNotificationEvents(
      { databaseDamage: { system: true } },
      { suppressDbDamageReminder: true },
    ).databaseDamage,
  ).toEqual({ banner: false, system: true });
  const f = configFixture();
  expect(f.open().getSettings().notificationEvents.databaseDamage).toEqual({
    banner: true,
    system: false,
  });
  f.service.setSettings({ suppressDbDamageReminder: true });
  expect(f.open().getSettings().notificationEvents.databaseDamage).toEqual({
    banner: false,
    system: false,
  });
  f.service.setSettings({ notificationEvents: { databaseDamage: { system: true } } });
  expect(f.open().getSettings().notificationEvents.databaseDamage).toEqual({
    banner: false,
    system: true,
  });
});
it('普通消息已明确选择的横幅渠道保留，缺省渠道使用新默认值', () => {
  const values = normalizeNotificationEvents({
    directMessage: { banner: true },
    groupMessage: { banner: false },
    assistantReply: { system: false },
  });
  expect(values.directMessage).toEqual({ banner: true, system: true });
  expect(values.groupMessage).toEqual({ banner: false, system: true });
  expect(values.assistantReply).toEqual({ banner: false, system: false });
});
it('首次读取及重开使用普通消息横幅关闭的默认值，显式开启后可持久保留', () => {
  const f = configFixture();
  for (const service of [f.service, f.open()]) {
    for (const event of NOTIFICATION_GROUPS[0].events)
      expect(service.getSettings().notificationEvents[event]).toEqual({
        banner: false,
        system: true,
      });
  }
  f.service.setSettings({
    notificationEvents: {
      directMessage: { banner: true },
      groupMessage: { system: false },
      recall: { banner: false },
    },
  });
  const values = f.open().getSettings().notificationEvents;
  expect(values.directMessage).toEqual({ banner: true, system: true });
  expect(values.groupMessage).toEqual({ banner: false, system: false });
  expect(values.recall).toEqual({ banner: false, system: false });
  expect(values.assistantReply).toEqual({ banner: false, system: true });
});
it('旧明确值保留，新配置逐列优先；无效值不污染其他项和默认对象', () => {
  const before = structuredClone(DEFAULT_NOTIFICATION_EVENTS);
  const values = normalizeNotificationEvents(
    { mail: { system: true }, recall: { banner: true }, failure: { system: 'yes' } },
    {
      messageNotifications: false,
      mailNotifications: false,
      recallNotifications: false,
      restrictedModeBannerEnabled: false,
    },
  );
  expect(values.directMessage.system).toBe(false);
  expect(values.groupMessage.system).toBe(false);
  expect(values.mail).toEqual({ banner: false, system: true });
  expect(values.recall).toEqual({ banner: true, system: false });
  expect(values.runtime.banner).toBe(false);
  expect(values.failure.system).toBe(false);
  expect(DEFAULT_NOTIFICATION_EVENTS).toEqual(before);
});
it('大项按列独立汇总，部分开启不冒充未知值', () => {
  const values = normalizeNotificationEvents(undefined);
  const events = NOTIFICATION_GROUPS[1].events;
  expect(notificationGroupState(events, 'system', values)).toEqual({ checked: false, mixed: true });
  for (const event of events) values[event].system = true;
  expect(notificationGroupState(events, 'system', values)).toEqual({ checked: true, mixed: false });
  expect(notificationGroupState(events, 'banner', values)).toEqual({ checked: false, mixed: true });
});
it('通知配置保存重开保留，单列更新不覆盖其他渠道，未触碰的配置仍保留旧值', () => {
  const f = configFixture({
    settings: {
      sharedPreferences: {
        client: { messageNotifications: false },
        mail: { mailNotifications: false },
        antiRecall: { notifyEnabled: true },
      },
      restrictedModeBannerEnabled: false,
    },
  });
  expect(f.service.getSettings().notificationEvents.recall.system).toBe(true);
  f.service.setSettings({ notificationEvents: { mail: { banner: true } } });
  f.service.setSettings({ showMessageTime: true });
  expect(f.open().getSettings().notificationEvents.mail).toEqual({ banner: true, system: false });
  expect(f.open().getSettings().notificationEvents.runtime.banner).toBe(false);
  expect(f.open().getSettings().notificationEvents.recall.system).toBe(true);
});
it('未配置的提醒范围默认全部，保留显式空名单', () => {
  expect(normalizeNotificationScope(undefined)).toEqual({ mode: 'all', targets: [] });
  expect(normalizeNotificationScope({ mode: 'selected', targets: [] })).toEqual({
    mode: 'selected',
    targets: [],
  });
  expect(
    normalizeNotificationScope({
      mode: 'all',
      targets: ['group:123', 'group:123', 123],
    }),
  ).toEqual({ mode: 'all', targets: ['group:123'] });
});
it('范围按数据源持久保存，写其他事件不覆盖已有名单，非法范围不写入', () => {
  const f = configFixture();
  const first = new ClientStateStore(join(f.root, 'source-a.json'));
  const second = new ClientStateStore(join(f.root, 'source-b.json'));
  first.records('notifications', { mentionMe: { mode: 'selected', targets: ['group:20001'] } });
  first.records('notifications', { mentionAll: { mode: 'all', targets: [] } });
  first.records('notifications', {
    replyMe: { mode: 'nonGroupAssistant', targets: ['group:20002'] },
    redPacket: { mode: 'nonMuted', targets: [] },
  });
  const reopened = new ClientStateStore(first.path).snapshot();
  expect(reopened.records.notifications).toEqual({
    mentionMe: { mode: 'selected', targets: ['group:20001'] },
    mentionAll: { mode: 'all', targets: [] },
    replyMe: { mode: 'nonGroupAssistant', targets: ['group:20002'] },
    redPacket: { mode: 'nonMuted', targets: [] },
  });
  expect(normalizeNotificationScope(reopened.records.notifications?.replyMe)).toEqual({
    mode: 'nonGroupAssistant',
    targets: ['group:20002'],
  });
  expect(normalizeNotificationScope(reopened.records.notifications?.redPacket).mode).toBe(
    'nonMuted',
  );
  expect(second.snapshot().records.notifications).toBeUndefined();
  expect(() =>
    first.records('notifications', { mentionMe: { mode: 'selected', targets: [1] } }),
  ).toThrow('无效的通知会话范围');
  expect(() =>
    first.records('notifications', { replyMe: { mode: 'unknown', targets: [] } }),
  ).toThrow('无效的通知会话范围');
  expect(new ClientStateStore(first.path).snapshot().records.notifications).toEqual(
    reopened.records.notifications,
  );
});
it('首次旧账号迁移前保存无关设置，不固化通知默认值遮蔽随后迁入的旧选择', () => {
  const f = configFixture();
  f.service.setSettings({ showMessageTime: true });
  expect(f.service.read().settings?.notificationEvents).toBeUndefined();
  f.service.patchSharedPreference('mail', { mailNotifications: false });
  f.service.patchSharedPreference('antiRecall', { notifyEnabled: true });
  expect(f.service.getSettings().notificationEvents.mail).toEqual({ banner: false, system: false });
  expect(f.service.getSettings().notificationEvents.recall.system).toBe(true);
});
it('首次打开全新账号不把旧版缺省关闭误迁成新事件表的显式关闭', () => {
  const f = configFixture();
  migrateSharedPreferences(f.service, f.root, join(f.root, 'cache'), 'fresh');
  const values = f.service.getSettings().notificationEvents;
  expect(values.groupMessage).toEqual({ banner: false, system: true });
  expect(values.mail).toEqual({ banner: true, system: true });
  expect(values.recall).toEqual({ banner: true, system: false });
});
it('仅定制一个事件不固化其他事件，随后迁入的旧提醒值仍能补全', () => {
  const f = configFixture();
  f.service.setSettings({ notificationEvents: { mail: { banner: true, system: true } } });
  expect(Object.keys(f.service.read().settings?.notificationEvents ?? {})).toEqual(['mail']);
  f.service.patchSharedPreference('antiRecall', { notifyEnabled: true });
  expect(f.open().getSettings().notificationEvents.recall.system).toBe(true);
  expect(f.open().getSettings().notificationEvents.mail).toEqual({ banner: true, system: true });
});
