import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ConversationWindowCache,
  conversationWindowKey,
} from '../src/renderer/src/lib/conversationWindowCache';

const window = (count: number) => ({
  rows: Array.from({ length: count }, (_, id) => ({ id })),
  anchored: true,
  hasOlder: false,
  hasNewer: false,
  scrollTop: 120,
  readingPosition: { scrollTop: 120, anchorId: '600', anchorSeq: '601', offset: -12 },
  revision: 0,
  dirty: false,
  storedAt: Date.now(),
  verifiedAt: Date.now(),
});
afterEach(() => vi.useRealTimers());

describe('会话阅读窗口缓存', () => {
  it('长窗口只保留锚点附近上下文，仍可双向翻页', () => {
    const cache = new ConversationWindowCache<{ id: number }>();
    const input = window(1000);
    cache.put('chat', input, 600);
    const result = cache.get('chat')!;
    expect(result.rows).toHaveLength(200);
    expect(result.rows.some((row) => row.id === 600)).toBe(true);
    expect(result).toMatchObject({
      anchored: false,
      hasOlder: true,
      hasNewer: true,
      readingPosition: input.readingPosition,
    });
    expect(input.rows).toHaveLength(1000);
  });
  it('消息窗口过期或容量淘汰后仍保留轻量阅读锚点', () => {
    vi.useFakeTimers();
    const cache = new ConversationWindowCache<{ id: number }>();
    const input = window(10);
    cache.put('expired', input);
    vi.advanceTimersByTime(11 * 60_000);
    expect(cache.get('expired')).toBeUndefined();
    expect(cache.getPosition('expired')).toEqual(input.readingPosition);
    cache.put('evicted', window(10));
    for (let i = 0; i < 13; i++) cache.put(`other:${i}`, window(10));
    expect(cache.get('evicted')).toBeUndefined();
    expect(cache.getPosition('evicted')).toEqual(input.readingPosition);
    cache.clear();
    expect(cache.getPosition('expired')).toBeUndefined();
  });
  it('账号、数据域与会话类型分别隔离', () => {
    const keys = [
      conversationWindowKey('account-a', 'c2c', '1'),
      conversationWindowKey('account-b', 'c2c', '1'),
      conversationWindowKey('account-a', 'group', '1'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
