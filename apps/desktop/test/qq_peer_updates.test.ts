import { expect, it, vi } from 'vitest';
import {
  publishQQPeerUpdate,
  replaceLoadedMembers,
  subscribeQQPeerUpdates,
  type QQPeerUpdate,
} from '../src/renderer/src/lib/qqPeerUpdates';

it('定向替换已加载成员，不改变分页顺序或插入未加载成员', () => {
  const loaded = [
    { uid: 'u_a', card: 'A' },
    { uid: 'u_b', card: '旧名片' },
  ];
  const updates = [
    { uid: 'u_b', card: '新名片' },
    { uid: 'u_c', card: '未加载' },
  ];
  const result = replaceLoadedMembers(loaded, updates);
  expect(result).toEqual([loaded[0], updates[0]]);
  expect(result[0]).toBe(loaded[0]);
  expect(loaded[1].card).toBe('旧名片');
});
it('缓存通知保留来源与目标，消费者卸载后不继续接收', async () => {
  const observer = vi.fn(async (_event: QQPeerUpdate) => {});
  const unsubscribe = subscribeQQPeerUpdates(observer);
  const event: QQPeerUpdate = {
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    target: { kind: 'profile', uid: 'u_peer' },
  };
  try {
    await publishQQPeerUpdate(event);
    expect(observer).toHaveBeenCalledWith(event);
    unsubscribe();
    await publishQQPeerUpdate(event);
    expect(observer).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
  }
});
