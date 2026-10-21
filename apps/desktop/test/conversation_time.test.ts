import { expect, it } from 'vitest';
import { formatConversationTimestamp } from '../src/renderer/src/lib/conversationTime';

it('群助手始终包含日期和时间，跨年带年份，显式按北京时间计算', () => {
  const now = new Date('2026-10-21T00:30:00+08:00');
  expect(formatConversationTimestamp('2026-10-20T16:01:00Z', now)).toBe('10-21 00:01');
  expect(formatConversationTimestamp('2026-10-20T15:59:00Z', now)).toBe('10-20 23:59');
  expect(formatConversationTimestamp('2025-10-20T15:59:00Z', now)).toBe('2025-10-20 23:59');
  expect(formatConversationTimestamp('invalid', now)).toBe('');
});
