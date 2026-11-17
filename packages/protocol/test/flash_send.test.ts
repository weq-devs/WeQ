import { describe, expect, it } from 'vitest';
import { decode, SendFlashMsg } from '../src';

const acceptedGroup = '0a081a0608021a02087b';
const acceptedFriend = '0a101a0e0801120a0a08755f667269656e64';
const rejected = '0a0b0807120765787069726564';

function parse(hex: string): void {
  SendFlashMsg.deserialize(decode(SendFlashMsg.respSchema, Buffer.from(hex, 'hex')));
}

describe('闪传分享逐目标结果', () => {
  it('群聊／私聊的成功状态可解析，不要求不存在的普通消息序号', () => {
    expect(() => parse(acceptedGroup)).not.toThrow();
    expect(() => parse(acceptedFriend)).not.toThrow();
  });
  it.each([acceptedGroup + rejected, rejected + acceptedFriend])(
    '任一目标失败都不能被其他成功项覆盖：%s',
    (hex) => expect(() => parse(hex)).toThrow(/7.*expired/),
  );
  it.each(['', '0a00', '0a020800'])('没有目标状态时不把缺省 0 当发送成功：%s', (hex) => {
    expect(() => parse(hex)).toThrow(/未确认/);
  });
});
