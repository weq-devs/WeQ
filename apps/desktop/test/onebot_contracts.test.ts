// @vitest-environment node
import { expect, it } from 'vitest';
import { parseSegments } from '../src/main/onebot/server';
import { bool, integer, serializeSegments, sendTarget } from '../src/main/onebot/contracts';

it('接受单段对象', () => {
  expect(parseSegments({ type: 'text', data: { text: '单段' } })).toEqual([
    { type: 'text', data: { text: '单段' } },
  ]);
});

it('规范化字符串布尔值和整数，不接受模糊真值', () => {
  for (const value of [false, 'false', '0', 0, 'no']) expect(bool(value, true)).toBe(false);
  for (const value of [true, 'true', '1', 1, 'yes']) expect(bool(value)).toBe(true);
  expect(bool(undefined, true)).toBe(true);
  expect(() => bool('off')).toThrow();
  expect(integer('1800')).toBe(1800);
  for (const value of ['', null, false, '1.2', -1]) expect(() => integer(value)).toThrow();
});

it('CQ 编解码保留控制段、正文和参数中的转义符', () => {
  const segments = [
    { type: 'text', data: { text: '&[CQ:at,qq=9]' } },
    { type: 'image', data: { file: 'a,b&[c]' } },
  ];
  expect(parseSegments(serializeSegments(segments))).toEqual(segments);
});

it('send_msg 推断目标并拒绝不明确的双目标和未知类型', () => {
  expect(sendTarget('send_msg', { group_id: '42' })).toEqual({ peerType: 'group', targetId: '42' });
  expect(sendTarget('send_msg', { user_id: 7 })).toEqual({ peerType: 'c2c', targetId: '7' });
  expect(() => sendTarget('send_msg', { group_id: 42, user_id: 7 })).toThrow();
  expect(() => sendTarget('send_msg', { message_type: 'typo', user_id: 7 })).toThrow();
});
