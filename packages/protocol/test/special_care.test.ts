import { describe, expect, it, vi } from 'vitest';
import { decode, encode, GetFriendSnsPage, SetFriendSpecialCare } from '../src/index';

describe('特别关心整体开关', () => {
  it.each([true, false])('三项整体写入并保留显式空值 %s', async (enabled) => {
    const sendOidbPacket = vi.fn(async () => Buffer.from([8, 0]));
    await SetFriendSpecialCare.invoke({ sendOidbPacket }, 7, { uid: 'u_friend', enabled });
    const call = sendOidbPacket.mock.calls[0] as unknown as unknown[];
    expect(call.slice(0, 3)).toEqual([7, 0x5d6, 6]);
    expect(call.slice(4)).toEqual([false, true]);
    // 固定 wire 样本独立于被测 schema，关闭值必须有 12 00，不能省略。
    const item = enabled ? '120131' : '1200';
    const target = `0a08755f667269656e648219${enabled ? '06' : '05'}08806a${item}8219${enabled ? '06' : '05'}08846a${item}8219${enabled ? '06' : '05'}08856a${item}`;
    expect(Buffer.from(call[3] as Uint8Array).toString('hex')).toBe(
      `080012${enabled ? '25' : '22'}${target}1801`,
    );
  });
  it('读取保留三个属性的值与存在性，不把缺失误作关闭', () => {
    const result = GetFriendSnsPage.deserialize(
      decode(
        GetFriendSnsPage.respSchema,
        encode(GetFriendSnsPage.respSchema, {
          friends: [
            {
              uid: 'u_friend',
              uin: 10002n,
              sns: [
                { key: 13573, value: Uint8Array.of(49) },
                { key: 13572, value: new Uint8Array() },
              ],
            },
          ],
        }),
      ),
    );
    expect(result.friends[0]?.specialCare).toEqual({
      enabled: true,
      zone: false,
      ring: null,
      enabledPresent: true,
      zonePresent: true,
      ringPresent: false,
    });
  });
  it('非规范提示音不猜作开关值', () => {
    const result = GetFriendSnsPage.deserialize({
      friends: [{ uid: 'u_friend', uin: 10002n, sns: [{ key: 13568, value: Uint8Array.of(48) }] }],
    });
    expect(result.friends[0]?.specialCare.ring).toBeNull();
  });
});
