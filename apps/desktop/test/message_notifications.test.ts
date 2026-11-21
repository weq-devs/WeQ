import { describe, expect, it } from 'vitest';
import {
  incomingImportantEvents,
  incomingNoticeEligible,
  incomingMessageCopy,
  applicationBadgeBitmap,
} from '../src/shared/message_notifications';
import { RedbagType } from '@weq/codec';
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
  it('从实时消息识别真实提及和红包，排除转账、发给别人的专属红包与引用', () => {
    expect([
      ...incomingImportantEvents(
        [
          { type: 'text', data: { textContent: '@全体成员' } },
          { type: 'reply', data: { origSenderUid: 'u_peer' } },
          { type: 'wallet', data: { walletRedbagType: RedbagType.TRANSFER } },
          {
            type: 'wallet',
            data: { walletRedbagType: RedbagType.DESIGNATED, walletDesignatedUin: 10002 },
          },
        ],
        options.selfUin,
        options.selfUid,
      ),
    ]).toEqual([]);
    expect([
      ...incomingImportantEvents(
        [
          { type: 'at', data: { atTargetUid: 'all' } },
          { type: 'at', data: { atTargetUid: options.selfUid } },
          { type: 'wallet', data: { walletRedbagType: RedbagType.LUCKY } },
        ],
        options.selfUin,
        options.selfUid,
      ),
    ]).toEqual(['mentionAll', 'mentionMe', 'redPacket']);
  });
  it('只接实时他人消息，排除旧导入、自己、漫游与前台阅读', () => {
    expect(incomingNoticeEligible(message, options)).toBe(true);
    for (const patch of [
      { sendTime: '900' },
      { senderUin: options.selfUin },
      { senderUid: options.selfUid },
      { source: 'roaming' },
      { msgSeq: '0' },
    ])
      expect(incomingNoticeEligible({ ...message, ...patch }, options)).toBe(false);
    expect(incomingNoticeEligible(message, { ...options, reading: true })).toBe(false);
    expect(incomingNoticeEligible({ ...message, senderUid: 'unverified' }, options)).toBe(false);
    expect(incomingNoticeEligible({ ...message, kind: 'group', conv: '10003' }, options)).toBe(
      true,
    );
  });
  it('回复预览不把引用原文放在新回复前，红包优先显示祝福语', () => {
    const options = { name: '摄影群', sender: '林林', count: 1 };
    expect(
      incomingMessageCopy({
        ...options,
        event: 'replyMe',
        elements: [
          { type: 'reply', data: { origText: '很长的原文，请勿显示' } },
          { type: 'text', data: { textContent: '我会参加' } },
        ],
      }),
    ).toMatchObject({ title: '回复你 · 摄影群', body: '林林：我会参加' });
    expect(
      incomingMessageCopy({
        ...options,
        event: 'redPacket',
        elements: [{ type: 'wallet', data: { walletDetail: { redbagTitle: '开工大吉' } } }],
      }),
    ).toMatchObject({ title: '红包 · 摄影群', body: '林林：开工大吉' });
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
