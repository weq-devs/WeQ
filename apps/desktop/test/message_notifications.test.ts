import { describe, expect, it } from 'vitest';
import {
  ordinaryNoticeEligible,
  applicationBadgeBitmap,
} from '../src/shared/message_notifications';
import { preferenceDefaults, validatePreferencePatch } from '@weq/service/client-preferences';
import { NEW_CONV_FRESH_SEC } from '@weq/service/live-message';

const message = {
  kind: 'c2c' as const,
  conv: 'u_peer',
  msgId: '1',
  msgSeq: '2',
  senderUid: 'u_peer',
  senderUin: '10002',
  sendTime: '1000',
};
const options = {
  selfUin: '10001',
  selfUid: 'u_self',
  openedAt: 990,
  observedAt: 1000,
  freshSeconds: NEW_CONV_FRESH_SEC,
  muted: false,
  reading: false,
};
describe('普通消息通知与应用角标', () => {
  it('通知默认关闭、角标默认开启，两个共享值独立校验', () => {
    expect(preferenceDefaults.messageNotifications).toBe(false);
    expect(preferenceDefaults.applicationBadge).toBe(true);
    expect(() =>
      validatePreferencePatch({ messageNotifications: true, applicationBadge: false }),
    ).not.toThrow();
    expect(() => validatePreferencePatch({ messageNotifications: 'true' })).toThrow();
  });
  it('只接实时他人消息，排除旧导入、自己、漫游、免打扰与前台阅读', () => {
    expect(ordinaryNoticeEligible(message, options)).toBe(true);
    for (const patch of [
      { sendTime: '900' },
      { senderUin: options.selfUin },
      { senderUid: options.selfUid },
      { source: 'roaming' },
      { msgSeq: '0' },
    ])
      expect(ordinaryNoticeEligible({ ...message, ...patch }, options)).toBe(false);
    expect(ordinaryNoticeEligible(message, { ...options, muted: true })).toBe(false);
    expect(ordinaryNoticeEligible(message, { ...options, reading: true })).toBe(false);
    expect(ordinaryNoticeEligible({ ...message, senderUid: 'unverified' }, options)).toBe(false);
    expect(ordinaryNoticeEligible({ ...message, kind: 'group', conv: '10003' }, options)).toBe(
      true,
    );
  });
  it('原生数字图标尺寸固定，零值透明，数字与 99+ 均有真实像素', () => {
    const red = Uint8Array.of(220, 38, 38, 255),
      white = Uint8Array.of(255, 255, 255, 255);
    expect(applicationBadgeBitmap(0, red, white).some(Boolean)).toBe(false);
    for (const count of [1, 25, 1000]) {
      const pixels = applicationBadgeBitmap(count, red, white);
      expect(pixels.length).toBe(16 * 16 * 4);
      expect(pixels[3]).toBe(0);
      expect(pixels.filter((value) => value === 255).length).toBeGreaterThan(100);
    }
    expect(applicationBadgeBitmap(100, red, white)).toEqual(
      applicationBadgeBitmap(10000, red, white),
    );
    expect(applicationBadgeBitmap(1, red, white)).not.toEqual(
      applicationBadgeBitmap(2, red, white),
    );
  });
});
