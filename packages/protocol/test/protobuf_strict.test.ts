import { describe, expect, it } from 'vitest';
import { decode, encode, message } from '../src/protobuf';

const schema = message([
  { name: 'child', tag: 1, type: message([{ name: 'text', tag: 1, type: 'string' }]) },
]);
describe('可选严格 protobuf 解码', () => {
  it('正常嵌套文本与未知字段保留兼容', () => {
    const bytes = encode(schema, { child: { text: '合成文本' } });
    expect(
      decode(schema, Buffer.concat([bytes, Buffer.from([0x50, 0])]), { strict: true }),
    ).toEqual({ child: { text: '合成文本' } });
  });
  it.each([
    [10, 8, 10], // 外层 LEN 截断
    [10, 2, 10, 3], // 子消息 LEN 截断
    [10, 1, 128], // 子消息 varint 截断
    [0], // tag 0
    [9, 0, 0, 0, 0, 0, 0, 0, 0], // 已知字段 wire 错配
    [0x51, 0], // 未知 fixed64 截断
    [0x55, 0], // 未知 fixed32 截断
    [0x52, 4, 0], // 未知 LEN 截断
    [10, 3, 10, 1, 255], // 非法 UTF-8
    [0x50, ...Array(11).fill(128)], // 超长 varint
  ])('严格模式拒绝损坏 wire %j', (bytes) => {
    expect(() => decode(schema, Buffer.from(bytes), { strict: true })).toThrow();
  });
  it('默认模式保持旧的宽松语义，严格检查不影响现有调用', () => {
    expect(decode(schema, Buffer.from([10, 8, 10]))).toEqual({ child: { text: '' } });
  });
});
