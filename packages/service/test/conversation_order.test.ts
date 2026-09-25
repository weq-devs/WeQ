/**
 * 会话列表排序口径的单测：`max(最后消息时间, 草稿时间)`，两个时间都来自数据库。
 *
 * 这是「有草稿的会话冒到列表前面」的全部逻辑依据 —— 排序键算错用户会立刻看到
 * 会话跳错位置，所以把边界钉死：只有草稿、只有新消息、两者都有、时间戳坏掉、
 * 以及草稿时间表的清洗规则。
 */

import { describe, expect, it } from 'vitest';
import {
  conversationSortTime,
  draftSortTimes,
  type ConversationDraftTimeRow,
} from '../src/account/conversation_order';

const row = (targetUid: string, draftTime: string): ConversationDraftTimeRow => ({
  targetUid,
  draftTime,
});

const at = (iso: string): number => Date.parse(iso);

describe('conversationSortTime', () => {
  it('草稿更新时按草稿时间（会话冒头）', () => {
    expect(conversationSortTime('2026-09-24T10:00:00Z', at('2026-09-25T09:00:00Z'))).toBe(
      at('2026-09-25T09:00:00Z'),
    );
  });

  it('来了新消息（晚于草稿）时按消息时间', () => {
    expect(conversationSortTime('2026-09-26T10:00:00Z', at('2026-09-25T09:00:00Z'))).toBe(
      at('2026-09-26T10:00:00Z'),
    );
  });

  it('没有草稿时等价于原来的 updatedAt 排序', () => {
    expect(conversationSortTime('2026-09-24T10:00:00Z', undefined)).toBe(
      at('2026-09-24T10:00:00Z'),
    );
  });

  it('时间戳解析不出来时仍按草稿时间参与排序', () => {
    expect(conversationSortTime('', at('2026-09-24T10:00:00Z'))).toBe(at('2026-09-24T10:00:00Z'));
    expect(conversationSortTime('not-a-date', undefined)).toBe(0);
  });
});

describe('draftSortTimes', () => {
  it('把库里的 41108（秒）换算成毫秒', () => {
    const map = draftSortTimes([row('u_a', '1790280959')]);
    expect(map).toEqual({ u_a: 1790280959 * 1000 });
  });

  it('忽略 0 / 非法 / 空 uid 的行', () => {
    const map = draftSortTimes([row('u_a', '0'), row('u_b', 'abc'), row('', '1790280959')]);
    expect(map).toEqual({});
  });

  it('空表 → 空映射（排序退回 updatedAt）', () => {
    expect(draftSortTimes([])).toEqual({});
  });

  it('多个会话各自保留自己的草稿时间', () => {
    const map = draftSortTimes([row('u_a', '1790280959'), row('u_b', '1790200000')]);
    expect(map).toEqual({
      u_a: 1790280959 * 1000,
      u_b: 1790200000 * 1000,
    });
  });
});
