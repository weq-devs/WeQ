// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { adjacentMessageId, edgeMessageId } from '../src/renderer/src/lib/messageKeyboardNav';

const IDS = ['m1', 'm2', 'm3'];

describe('message_keyboard_nav', () => {
  it('向下 / 向上移动到相邻消息，到边界后不再移动', () => {
    expect(adjacentMessageId(IDS, 'm1', 1)).toBe('m2');
    expect(adjacentMessageId(IDS, 'm2', 1)).toBe('m3');
    expect(adjacentMessageId(IDS, 'm3', 1)).toBeUndefined();
    expect(adjacentMessageId(IDS, 'm3', -1)).toBe('m2');
    expect(adjacentMessageId(IDS, 'm1', -1)).toBeUndefined();
  });

  it('只有一条消息时，上下都不移动', () => {
    expect(adjacentMessageId(['only'], 'only', 1)).toBeUndefined();
    expect(adjacentMessageId(['only'], 'only', -1)).toBeUndefined();
  });

  it('空列表 / 当前不在列表里时不给出目标，避免把焦点扔到别的会话', () => {
    expect(adjacentMessageId([], 'm1', 1)).toBeUndefined();
    expect(adjacentMessageId(IDS, null, 1)).toBeUndefined();
    expect(adjacentMessageId(IDS, '', 1)).toBeUndefined();
    expect(adjacentMessageId(IDS, 'not-in-list', 1)).toBeUndefined();
  });

  it('Home / End 取首尾消息', () => {
    expect(edgeMessageId(IDS, 'first')).toBe('m1');
    expect(edgeMessageId(IDS, 'last')).toBe('m3');
    expect(edgeMessageId([], 'first')).toBeUndefined();
    expect(edgeMessageId([], 'last')).toBeUndefined();
  });
});
