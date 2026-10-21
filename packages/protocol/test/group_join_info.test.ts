import { describe, expect, it } from 'vitest';
import { GetGroupJoinInfo } from '../src/oidb/request/get-group-join-info';
import { SendGroupJoinRequest } from '../src/oidb/request/send-group-join-request';
import { decode, encode } from '../src/protobuf';

const createOidbStub = (reply: Uint8Array) => ({
  nt: { sendOidbPacket: async () => Buffer.from(reply) },
});

describe('入群资料和回执', () => {
  it('请求明确选择问题和分类字段，不查询标准答案', () => {
    const body = GetGroupJoinInfo.serialize({ groupId: 123 });
    const decoded = decode(GetGroupJoinInfo.reqSchema, encode(GetGroupJoinInfo.reqSchema, body));
    expect(decoded.groups).toEqual([
      {
        groupCode: 123n,
        info: { option: 0, categoryId: 0, name: '', categoryName: '', question: '' },
      },
    ]);
    expect(Buffer.from(encode(GetGroupJoinInfo.reqSchema, body)).toString('hex')).toContain(
      '1210087b120c380040007a00920100c20100',
    );
    expect(JSON.stringify(body)).not.toContain('answer');
  });
  it('分类只使用响应中的编号和名称，显式 0 与未返回分开', () => {
    const read = (info: Record<string, unknown>) =>
      GetGroupJoinInfo.deserialize({
        groups: [{ groupCode: 123n, info }],
      })[0];
    expect(read({ categoryId: 0, categoryName: '服务端分类' })).toMatchObject({
      categoryId: 0,
      categoryName: '服务端分类',
    });
    expect(read({})).toMatchObject({ categoryId: null, categoryName: null });
  });
  it('问题缺失不等于没有问题，只有明确非问题模式才标不需要', () => {
    expect(
      GetGroupJoinInfo.deserialize({ groups: [{ groupCode: 123n, info: { option: 4 } }] })[0]
        ?.questionState,
    ).toBe('unavailable');
    expect(
      GetGroupJoinInfo.deserialize({ groups: [{ groupCode: 123n, info: { option: 2 } }] })[0]
        ?.questionState,
    ).toBe('not-required');
    expect(
      GetGroupJoinInfo.deserialize({
        groups: [{ groupCode: 123n, info: { option: 5, question: '验证问题' } }],
      })[0]?.question,
    ).toBe('验证问题');
    expect(() =>
      GetGroupJoinInfo.deserialize({ groups: [{ groupCode: 123n, result: 1 }] }),
    ).toThrow('拒绝');
  });
  it('拒绝错群回包', async () => {
    const { nt } = createOidbStub(
      encode(GetGroupJoinInfo.respSchema, {
        groups: [{ groupCode: 999n, result: 0, info: { option: 1 } }],
      }),
    );
    await expect(GetGroupJoinInfo.invoke(nt, 101, { groupId: 123 })).rejects.toThrow('不一致');
  });
  it('提交回答，非空未知回包不冒称已受理', async () => {
    const params = { groupCode: 123, authKey: 'synthetic-test-key', answer: '我的回答' };
    const normal = createOidbStub(new Uint8Array([0x12, 0]));
    await expect(SendGroupJoinRequest.invokeWithOutcome(normal.nt, 101, params)).resolves.toBe(
      'accepted',
    );
    const unknown = createOidbStub(new Uint8Array([0x12, 1, 65]));
    await expect(SendGroupJoinRequest.invokeWithOutcome(unknown.nt, 101, params)).resolves.toBe(
      'unconfirmed',
    );
  });
});
