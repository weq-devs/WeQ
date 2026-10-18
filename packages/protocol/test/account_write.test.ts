import { describe, expect, it } from 'vitest';
import { encode, decode } from '../src/protobuf';
import {
  SetFriendRemark,
  ClearFriendRemark,
  SetGroupRemark,
  SetFriendCategory,
  SetPeerPin,
  SetFriendDisturb,
  SetGroupMessagePolicy,
  SetSelfProfile,
  SetOnlineStatus,
  SNS_FRIEND_PIN,
  SNS_GROUP_PIN,
  SNS_FRIEND_DISTURB,
  PROFILE_NICKNAME,
  PROFILE_SIGNATURE,
  PROFILE_GENDER,
  GROUP_MESSAGE_POLICIES,
} from '../src';

function native(reply = Buffer.alloc(0)) {
  const calls: Array<{
    pid: number;
    command: number;
    sub: number;
    bytes: Buffer;
    uid: boolean;
    sign: boolean;
  }> = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      sub: number,
      bytes: Buffer,
      uid: boolean,
      sign: boolean,
    ) => {
      calls.push({ pid, command, sub, bytes, uid, sign });
      return reply;
    },
  };
}

describe('联系人写协议', () => {
  it('好友备注显式发送 scene=0，响应确认后才接受', async () => {
    const p = { uid: 'u_a', remark: 'A' };
    const bytes = encode(SetFriendRemark.reqSchema, SetFriendRemark.serialize(p));
    expect(Buffer.from(bytes).toString('hex')).toBe('0a0a0a053a03755f611201411000');
    const nt = native(
      Buffer.from(
        encode(SetFriendRemark.respSchema, {
          result: { target: { uid: p.uid }, remark: p.remark },
        }),
      ),
    );
    await SetFriendRemark.invoke(nt, 4, p);
    expect(nt.calls[0]).toMatchObject({ pid: 4, command: 0x912e, sub: 0, uid: false, sign: false });
  });

  it('拒绝错目标、错值、缺失结果及嵌套业务错误', async () => {
    for (const response of [
      {},
      { result: { target: { uid: 'u_b' }, remark: 'A' } },
      { result: { target: { uid: 'u_a' }, remark: 'B' } },
      { error: { code: 12, message: 'denied' } },
      { error: {} },
    ]) {
      const nt = native(Buffer.from(encode(SetFriendRemark.respSchema, response)));
      await expect(SetFriendRemark.invoke(nt, 1, { uid: 'u_a', remark: 'A' })).rejects.toThrow();
      expect(nt.calls).toHaveLength(1);
    }
  });

  it('清除好友备注用独立命令，不向设置命令发送空串', async () => {
    expect(() => SetFriendRemark.serialize({ uid: 'u_a', remark: '' })).toThrow(/清除/);
    const nt = native();
    await ClearFriendRemark.invoke(nt, 2, { uid: 'u_a' });
    expect(nt.calls[0]).toMatchObject({ command: 0x912f, sub: 0 });
    expect(nt.calls[0]?.bytes.toString('hex')).toBe('0a053a03755f61');
  });

  it('群备注清空保留值字段，拒绝业务错误和错群回包', async () => {
    const p = { groupId: 100, remark: '' };
    expect(
      Buffer.from(encode(SetGroupRemark.reqSchema, SetGroupRemark.serialize(p))).toString('hex'),
    ).toBe('0a0408641a00');
    for (const response of [{ body: { groupId: 101n } }, { body: { groupId: 100n, code: 2 } }]) {
      const nt = native(Buffer.from(encode(SetGroupRemark.respSchema, response)));
      await expect(SetGroupRemark.invoke(nt, 1, p)).rejects.toThrow();
    }
  });

  it('移动到默认分组保留 categoryId=0 并使用 uin-form', async () => {
    const nt = native();
    await SetFriendCategory.invoke(nt, 1, { uid: 'u_a', categoryId: 0 });
    expect(nt.calls[0]).toMatchObject({ command: 0x1255, sub: 0, uid: true });
    expect(nt.calls[0]?.bytes.toString('hex')).toBe('0a03755f611000');
  });

  it('非法目标或整数在发送之前拒绝', async () => {
    const nt = native();
    for (const groupId of [-1, 0, 1.5, 2 ** 32, Number.NaN])
      await expect(SetGroupRemark.invoke(nt, 1, { groupId, remark: 'A' })).rejects.toThrow();
    await expect(ClearFriendRemark.invoke(nt, 1, { uid: '12345' })).rejects.toThrow();
    expect(nt.calls).toHaveLength(0);
  });
});

describe('置顶与消息策略', () => {
  it.each(['c2c', 'group'] as const)('置顶 %s 的属性、domain 与四字节大端时间', async (kind) => {
    const target = kind === 'c2c' ? { kind, uid: 'u_a' } : { kind, groupId: 100 };
    const data = decode(
      SetPeerPin.reqSchema,
      encode(
        SetPeerPin.reqSchema,
        SetPeerPin.serialize({ target, enabled: true, timestamp: 0x01020304 }),
      ),
    );
    expect(data).toMatchObject({
      domain: kind === 'group' ? 11 : 1,
      target: {
        item: {
          type: kind === 'group' ? SNS_GROUP_PIN : SNS_FRIEND_PIN,
          value: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });
    const nt = native();
    await SetPeerPin.invoke(nt, 1, { target, enabled: false });
    const decoded = decode(SetPeerPin.reqSchema, nt.calls[0]!.bytes);
    expect(decoded).toMatchObject({
      sequence: 0,
      target: { item: { type: kind === 'group' ? SNS_GROUP_PIN : SNS_FRIEND_PIN } },
    });
    expect(nt.calls[0]?.sub).toBe(kind === 'group' ? 1 : 18);
    expect((decoded.target as { item: object }).item).not.toHaveProperty('value');
  });

  it('好友免打扰开启是八字节，关闭省略值，未读回不宣称已验证', async () => {
    const data = decode(
      SetFriendDisturb.reqSchema,
      encode(
        SetFriendDisturb.reqSchema,
        SetFriendDisturb.serialize({ uid: 'u_a', enabled: true, timestamp: 0x01020304 }),
      ),
    );
    expect(data).toMatchObject({
      domain: 1,
      target: {
        item: {
          type: SNS_FRIEND_DISTURB,
          value: new Uint8Array([1, 2, 3, 4, 255, 255, 255, 255]),
        },
      },
    });
    const nt = native();
    expect(await SetFriendDisturb.invoke(nt, 1, { uid: 'u_a', enabled: false })).toBe(
      'unconfirmed',
    );
    expect(nt.calls[0]).toMatchObject({ command: 0x5d6, sub: 19 });
    expect(
      (decode(SetFriendDisturb.reqSchema, nt.calls[0]!.bytes).target as { item: object }).item,
    ).not.toHaveProperty('value');
  });

  it.each(GROUP_MESSAGE_POLICIES)('群策略 %i 原值上 wire 且校验回包群号', async (policy) => {
    const reply = Buffer.from(encode(SetGroupMessagePolicy.respSchema, { body: { groupId: 100 } }));
    const nt = native(reply);
    await SetGroupMessagePolicy.invoke(nt, 1, { groupId: 100, selfUid: 'u_self', policy });
    expect(decode(SetGroupMessagePolicy.reqSchema, nt.calls[0]!.bytes)).toEqual({
      body: {
        groupId: 100,
        setting: { selfUid: 'u_self', policy },
        field3: 1,
        field4: 2,
      },
    });
    expect(nt.calls[0]).toMatchObject({ command: 0xa80, sub: 1 });
  });

  it('缺 body、错误群号和内层拒绝均不当成成功', async () => {
    for (const response of [
      {},
      { body: {} },
      { body: { groupId: 101 } },
      { body: { groupId: 100, code: 7 } },
    ]) {
      const nt = native(Buffer.from(encode(SetGroupMessagePolicy.respSchema, response)));
      await expect(
        SetGroupMessagePolicy.invoke(nt, 1, { groupId: 100, selfUid: 'u_self', policy: 4 }),
      ).rejects.toThrow();
    }
  });
});

describe('个人资料补丁与状态', () => {
  it('只发送修改字段，签名清空和性别 0 仍显式上 wire', async () => {
    const nt = native();
    await SetSelfProfile.invoke(nt, 1, { uin: '10001', signature: '', gender: 0 });
    expect(decode(SetSelfProfile.reqSchema, nt.calls[0]!.bytes)).toEqual({
      uin: 10001n,
      strings: [{ key: PROFILE_SIGNATURE, value: '' }],
      numbers: [{ key: PROFILE_GENDER, value: 0 }],
    });
    expect(SetSelfProfile.serialize({ uin: '10001', nickname: '新名字' })).toMatchObject({
      strings: [{ key: PROFILE_NICKNAME, value: '新名字' }],
    });
    await SetSelfProfile.invoke(nt, 1, { uin: '10001' });
    expect(nt.calls).toHaveLength(1);
    expect(nt.calls[0]).toMatchObject({ command: 0x112a, sub: 2, sign: true });
  });

  it('普通状态清空扩展状态，自定义状态校验组合并检查业务错误', () => {
    expect(SetOnlineStatus.serialize({ status: 10 })).toEqual({
      status: 10,
      extStatus: 0,
      batteryStatus: 0,
    });
    expect(() =>
      SetOnlineStatus.serialize({ status: 40, custom: { faceId: 1, faceType: 1, wording: 'A' } }),
    ).toThrow(/自定义/);
    expect(() => SetOnlineStatus.deserialize({ code: 12, message: 'denied' })).toThrow(/12/);
  });
});
