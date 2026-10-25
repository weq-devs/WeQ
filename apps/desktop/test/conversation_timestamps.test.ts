// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  formatConversationTime,
  formatConversationTimestamp,
} from '../src/renderer/src/lib/conversationTime';
import {
  virtualConversationRow,
  virtualConversationTime,
} from '../src/renderer/src/lib/conversationDirectory';

describe('conversation_time', () => {
  it('相对时间按日历日判断跨年昨天，缺失或无效时间不显示', () => {
    const now = new Date(2026, 0, 1, 0, 30);
    expect(formatConversationTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('昨天');
    expect(formatConversationTime(undefined, now)).toBe('');
    expect(formatConversationTime('', now)).toBe('');
    expect(formatConversationTime('invalid', now)).toBe('');
  });

  it('完整时间格式始终包含日期和时间，跨年带年份，显式按北京时间计算', () => {
    const now = new Date('2026-10-21T00:30:00+08:00');
    expect(formatConversationTimestamp('2026-10-20T16:01:00Z', now)).toBe('10-21 00:01');
    expect(formatConversationTimestamp('2026-10-20T15:59:00Z', now)).toBe('10-20 23:59');
    expect(formatConversationTimestamp('2025-10-20T15:59:00Z', now)).toBe('2025-10-20 23:59');
    expect(formatConversationTimestamp('invalid', now)).toBe('');
  });
});

describe('virtual_conversation_time', () => {
  const NOW = 1_792_000_000;
  // unix 秒
  const NOW_MS = NOW * 1000;

  it('没有消息时用创建时间（毫秒换算成秒），不会因为单位混用跑到最前面', () => {
    const item = {
      id: 'virtual:persona:p1',
      kind: 'persona' as const,
      ownerId: 'p1',
      name: '合成克隆',
      updatedAt: NOW_MS,
    };
    expect(virtualConversationTime(item)).toBe(NOW);
    // 必须和真实会话的时间同一量级：毫秒值直接返回会大 1000 倍，排序就永远排第一。
    expect(virtualConversationTime(item)).toBeLessThan(1e11);
  });

  it('有消息时以最后一条消息为准，优先于画像更新时间', () => {
    expect(
      virtualConversationTime({
        id: 'virtual:persona:p1',
        kind: 'persona',
        ownerId: 'p1',
        name: '合成克隆',
        updatedAt: NOW_MS,
        lastMessageTime: NOW + 600,
      }),
    ).toBe(NOW + 600);
  });

  it('两者都没有时返回 0，交给列表按置顶规则排到最后', () => {
    expect(
      virtualConversationTime({
        id: 'virtual:group:g1',
        kind: 'group',
        ownerId: 'g1',
        name: '合成克隆群',
      }),
    ).toBe(0);
  });

  it('列表行的更新时间与最后一条消息都按同一份秒值生成', () => {
    const row = virtualConversationRow({
      id: 'virtual:persona:p1',
      kind: 'persona',
      ownerId: 'p1',
      name: '合成克隆',
      updatedAt: NOW_MS,
      lastMessageTime: NOW + 60,
      preview: '在吗',
      previewMine: false,
    });
    expect(row.updatedAt).toBe(new Date((NOW + 60) * 1000).toISOString());
    expect(row.lastMessage?.createdAt).toBe(row.updatedAt);
    expect(row.lastMessage?.body).toBe('在吗');
  });
});
