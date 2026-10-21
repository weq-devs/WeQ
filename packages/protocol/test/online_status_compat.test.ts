import { describe, expect, it } from 'vitest';
import { decode, SetOnlineStatus, SetDiyOnlineStatus } from '../src';
import { SetOnlineStatus as DomainStatus } from '../src/oidb/profile/status';
import { SetOnlineStatus as LegacyStatus } from '../src/oidb/set-self-profile';

describe('在线状态合并兼容', () => {
  it('根导出、分域入口与旧入口共用同一个实现', () => {
    expect(SetOnlineStatus).toBe(DomainStatus);
    expect(LegacyStatus).toBe(DomainStatus);
  });

  it('旧自定义参数映射到统一 wire，显式保留清空扩展状态的零值', async () => {
    const calls: Array<{ body: Buffer; needSign?: boolean }> = [];
    const nt = {
      sendPacket: async (_pid: number, _cmd: string, body: Buffer, needSign?: boolean) => {
        calls.push({ body, needSign });
        return Buffer.alloc(0);
      },
    };
    await SetOnlineStatus.invoke(nt, 1, {
      status: 10,
      extStatus: 2000,
      batteryStatus: 0,
      custom: { faceId: 1, wording: '合成状态', faceType: 2 },
    });
    expect(calls[0]?.needSign).toBe(false);
    expect(decode(DomainStatus.reqSchema, calls[0]!.body)).toEqual({
      status: 10,
      extStatus: 2000,
      batteryStatus: 0,
      customExt: { faceId: 1, text: '合成状态', faceType: 2 },
    });
    await SetOnlineStatus.invoke(nt, 1, { status: 10, extStatus: 0, batteryStatus: 0 });
    expect(decode(DomainStatus.reqSchema, calls[1]!.body)).toEqual({
      status: 10,
      extStatus: 0,
      batteryStatus: 0,
    });
    expect(SetDiyOnlineStatus.serialize({ faceId: 1, text: '合成状态', faceType: 2 })).toEqual(
      SetOnlineStatus.serialize({
        status: 10,
        extStatus: 2000,
        batteryStatus: 0,
        custom: { faceId: 1, wording: '合成状态', faceType: 2 },
      }),
    );
  });

  it('非零业务码即使没有错误文案也不能报告成功', () => {
    expect(() => SetOnlineStatus.deserialize({ errCode: 12 })).toThrow(/12/);
    expect(() =>
      SetOnlineStatus.deserialize({ errCode: 12, errMsg: 'set status success' }),
    ).toThrow(/12/);
    expect(() => SetOnlineStatus.deserialize({ errCode: 0, errMsg: 'denied' })).toThrow(/denied/);
    expect(() =>
      SetOnlineStatus.deserialize({ errCode: 0, errMsg: 'set status success' }),
    ).not.toThrow();
    expect(() => SetOnlineStatus.deserialize({})).not.toThrow();
  });

  it('编码前拒绝越界、非整数与错误的自定义组合', () => {
    for (const status of [-1, 1.5, Number.NaN, 0x80000000])
      expect(() => SetOnlineStatus.serialize({ status })).toThrow();
    expect(() => SetOnlineStatus.serialize({ status: 10, extStatus: 0x80000000 })).toThrow();
    expect(() => SetOnlineStatus.serialize({ status: 10, batteryStatus: -1 })).toThrow();
    expect(() =>
      SetOnlineStatus.serialize({ status: 40, custom: { faceId: 1, wording: 'A', faceType: 1 } }),
    ).toThrow(/自定义/);
    expect(() => SetDiyOnlineStatus.serialize({ faceId: -1, text: 'A', faceType: 1 })).toThrow();
    expect(() => SetDiyOnlineStatus.serialize({ faceId: 1, text: ' ', faceType: 1 })).toThrow();
  });
});
