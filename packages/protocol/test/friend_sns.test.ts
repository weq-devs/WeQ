import { describe, expect, it } from 'vitest';
import { decode, encode, GetFriendSnsPage, SNS_FRIEND_DISTURB } from '../src/index';

describe('0xFD4 好友 SNS 子结构', () => {
  it('独立原始字节样本把好友 tag101、SNS tag10002 和 UID/UIN 分别解码', () => {
    // 合成账号与好友；按官方字段表手写 wire，不用被测编码器生成期望。
    const bytes = Buffer.from(
      '38914eaa061e0a08755f667269656e6418924e92f1040d088b6a120800000001ffffffff',
      'hex',
    );
    expect(GetFriendSnsPage.deserialize(decode(GetFriendSnsPage.respSchema, bytes))).toEqual({
      selfUin: '10001',
      friends: [{ uid: 'u_friend', uin: '10002', disturb: true, disturbPresent: true }],
    });
  });
  it('规范空属性与未返回属性必须保留不同的存在性', () => {
    const bytes = Buffer.from('38914eaa06160a08755f667269656e6418924e92f10405088b6a1200', 'hex');
    expect(
      GetFriendSnsPage.deserialize(decode(GetFriendSnsPage.respSchema, bytes)).friends[0],
    ).toMatchObject({
      disturb: false,
      disturbPresent: true,
    });
    const absent = Buffer.from('38914eaa060d0a08755f667269656e6418924e', 'hex');
    expect(
      GetFriendSnsPage.deserialize(decode(GetFriendSnsPage.respSchema, absent)).friends[0],
    ).toMatchObject({
      disturb: null,
      disturbPresent: false,
    });
  });
  it('末页只有结束标志时仍是可识别的空页，不与零字节回包混同', () => {
    expect(
      GetFriendSnsPage.deserialize(decode(GetFriendSnsPage.respSchema, Uint8Array.of(24, 1))),
    ).toEqual({ friends: [] });
  });
  it.each([
    {},
    { selfUin: 1n, friends: [{ uid: 'bad', uin: 2n }] },
    { selfUin: 1n, friends: [{ uid: 'u_friend' }] },
    { selfUin: 1n, friends: [{ uid: 'u_friend', uin: 2n, sns: [{ key: SNS_FRIEND_DISTURB }] }] },
    {
      selfUin: 1n,
      friends: [
        {
          uid: 'u_friend',
          uin: 2n,
          sns: [
            { key: SNS_FRIEND_DISTURB, value: new Uint8Array() },
            { key: SNS_FRIEND_DISTURB, value: Uint8Array.of(1) },
          ],
        },
      ],
    },
  ])('空回包与异常身份／属性不能成为关闭状态 %#', (body) => {
    expect(() =>
      GetFriendSnsPage.deserialize(
        decode(GetFriendSnsPage.respSchema, encode(GetFriendSnsPage.respSchema, body)),
      ),
    ).toThrow();
  });
});
