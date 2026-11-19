import { describe, expect, it } from 'vitest';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import {
  NOTIFICATION_METHODS,
  notificationMethodOf,
  notificationEventPatch,
  notificationEventUpdateInput,
} from '../src/shared/notification_method';

describe('通知方式与原子更新契约', () => {
  it.each(NOTIFICATION_METHODS)('$label 双渠道往返一致，更新不覆盖其他事件', (method) => {
    const current = normalizeNotificationEvents(undefined);
    const snapshot = structuredClone(current);
    const input = notificationEventUpdateInput.parse({
      events: ['mail'],
      channels: method.channels,
    });
    expect(notificationMethodOf(method.channels)).toBe(method.value);
    expect(notificationEventPatch(current, input)).toEqual({ mail: method.channels });
    expect(current).toEqual(snapshot);
  });
  it('兼容统一设置表的单渠道批量更新，不改变另一渠道', () => {
    const current = normalizeNotificationEvents(undefined);
    const input = notificationEventUpdateInput.parse({
      events: ['mail', 'recall'],
      channel: 'system',
      enabled: false,
    });
    expect(notificationEventPatch(current, input)).toEqual({
      mail: { ...current.mail, system: false },
      recall: { ...current.recall, system: false },
    });
  });
  it.each([
    { events: [], channels: { banner: true, system: true } },
    { events: ['unknown'], channels: { banner: true, system: true } },
    { events: ['mail'], channels: { banner: true } },
    { events: ['mail'], channels: { banner: 'false', system: false } },
    { events: ['mail'], channel: 'system' },
  ])('拒绝不完整或非法更新：%j', (input) => {
    expect(notificationEventUpdateInput.safeParse(input).success).toBe(false);
  });
});
