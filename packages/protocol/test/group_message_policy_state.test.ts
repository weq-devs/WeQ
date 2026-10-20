import { describe, expect, it, vi } from 'vitest';
import { decode, encode, GetGroupMessagePolicies } from '../src/index';

describe('群消息策略服务端读回', () => {
  it('沿用标准群列表配置和现有 OIDB 传输，仅返回策略', async () => {
    const body = encode(GetGroupMessagePolicies.reqSchema, GetGroupMessagePolicies.serialize({}));
    expect(Buffer.from(body).toString('hex')).toBe(
      '0a260a1a0801100118012001280148015001900101980101a80101f0010112081001180120013801',
    );
    const sendOidbPacket = vi.fn(async () =>
      Buffer.from(
        encode(GetGroupMessagePolicies.respSchema, {
          groups: [{ groupId: 123, personal: { policy: 3 } }],
        }),
      ),
    );
    expect(await GetGroupMessagePolicies.invoke({ sendOidbPacket }, 9)).toEqual([
      { groupId: 123, policy: 3, rawPolicy: 3 },
    ]);
    expect(sendOidbPacket.mock.calls).toHaveLength(1);
  });
  it('保留四档策略，缺失或未知值不能冒充正常提醒', () => {
    const rows = GetGroupMessagePolicies.deserialize(
      decode(
        GetGroupMessagePolicies.respSchema,
        encode(GetGroupMessagePolicies.respSchema, {
          groups: [
            ...[1, 4, 2, 3].map((policy) => ({ groupId: 100 + policy, personal: { policy } })),
            { groupId: 200, personal: { policy: 99 } },
            { groupId: 201 },
          ],
        }),
      ),
    );
    expect(rows.map((row) => row.policy)).toEqual([1, 4, 2, 3, null, null]);
    expect(rows[4].rawPolicy).toBe(99);
    expect(rows[5].rawPolicy).toBeNull();
  });
  it('缺结果或非法群号拒绝读回，不制造空成功', () => {
    expect(() => GetGroupMessagePolicies.deserialize({})).toThrow('未返回');
    expect(() => GetGroupMessagePolicies.deserialize({ groups: [{ groupId: 0 }] })).toThrow('群号');
  });
});
