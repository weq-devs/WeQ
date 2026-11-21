import { expect, it } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_GROUPS,
  normalizeNotificationEvents,
  notificationGroupState,
  mergeNotificationEventOverrides,
  normalizeNotificationScope,
} from '../src/common/notification_settings';
it('通知目录四组且事件不重复，普通消息仅系统通知', () => {
  expect(NOTIFICATION_GROUPS).toHaveLength(4);
  expect(new Set(NOTIFICATION_EVENTS).size).toBe(NOTIFICATION_EVENTS.length);
  expect(NOTIFICATION_GROUPS.find((group) => group.id === 'app')?.events).toEqual(
    expect.arrayContaining(['databaseDamage', 'officialAnnouncement']),
  );
  const values = normalizeNotificationEvents(undefined);
  expect(notificationGroupState(NOTIFICATION_GROUPS[0].events, 'banner', values)).toEqual({
    checked: false,
    mixed: false,
  });
  expect(notificationGroupState(NOTIFICATION_GROUPS[0].events, 'system', values)).toEqual({
    checked: true,
    mixed: false,
  });
  expect(values.redPacket).toEqual({ banner: false, system: false });
  expect(values.recall).toEqual({ banner: true, system: false });
});
it('只覆盖已提供的布尔渠道，显式关闭不丢失，也不固化其他事件默认值', () => {
  const patch = mergeNotificationEventOverrides(
    { mail: { system: false } },
    { mail: { banner: true }, unknown: { banner: true } },
  );
  expect(patch).toEqual({ mail: { banner: true, system: false } });
  expect(normalizeNotificationEvents(patch).mail).toEqual({ banner: true, system: false });
});
it('范围空名单保持指定空名单，全部模式切换不清理已选会话', () => {
  expect(normalizeNotificationScope({ mode: 'selected', targets: [] })).toEqual({
    mode: 'selected',
    targets: [],
  });
  expect(
    normalizeNotificationScope({
      mode: 'all',
      targets: ['group:20001', 'group:20001'],
    }),
  ).toEqual({ mode: 'all', targets: ['group:20001'] });
});
