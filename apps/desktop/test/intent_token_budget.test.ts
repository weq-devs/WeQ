import { expect, it } from 'vitest';
import { prioritizeCurrentMessageTokens } from '../src/main/intent_sense/token_budget';

it('历史超长时保留当前消息及末尾标记，且不超出模型长度', () => {
  const full = [101, ...Array.from({ length: 180 }, (_, i) => i + 1), 700, 701, 102];
  const current = [101, 700, 701, 102];
  const kept = prioritizeCurrentMessageTokens(full, current, 128);
  expect(kept).toHaveLength(128);
  expect(kept[0]).toBe(101);
  expect(kept.slice(-3)).toEqual([700, 701, 102]);
});

it('没有超限时不改动完整上下文', () => {
  expect(prioritizeCurrentMessageTokens([101, 5, 6, 102], [101, 6, 102], 128)).toEqual([
    101, 5, 6, 102,
  ]);
});

it('当前消息本身过长时优先保存消息开头，不再使用历史 token', () => {
  const message = [101, ...Array.from({ length: 200 }, (_, i) => i + 1), 102];
  const full = [101, ...Array.from({ length: 100 }, () => 999), ...message.slice(1)];
  expect(prioritizeCurrentMessageTokens(full, message, 128)).toEqual(message.slice(0, 128));
});
