/**
 * 虚拟会话（克隆体 / 克隆群）在会话列表里的排序时间。
 *
 * 回归点：`updatedAt` 是毫秒、`lastMessageTime` 是秒。以前两者直接 `??` 混用，
 * 刚建好、还没有消息的克隆体会拿到一个「秒」量级的十几倍大数字，被排到列表最前。
 */

import { expect, it } from 'vitest';
import {
  virtualConversationRow,
  virtualConversationTime,
} from '../src/renderer/src/lib/conversationDirectory';

const NOW = 1_792_000_000; // unix 秒
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
