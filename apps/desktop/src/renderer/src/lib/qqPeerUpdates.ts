import type { QQWriteBinding } from '../hooks/useQQWriteSession';

export type QQPeerUpdate = {
  binding: QQWriteBinding;
  target: { kind: 'profile'; uid: string } | { kind: 'member'; groupCode: string; uid: string };
};
const listeners = new Set<(update: QQPeerUpdate) => Promise<void>>();

export function replaceLoadedMembers<T extends { uid: string }>(
  loaded: readonly T[],
  updates: readonly T[],
): T[] {
  const byUid = new Map(updates.map((member) => [member.uid, member]));
  return loaded.map((member) => byUid.get(member.uid) ?? member);
}

/** 普通查询失效无法刷新主界面的按需内存缓存，保存读回后定向通知其实际消费者。 */
export async function publishQQPeerUpdate(update: QQPeerUpdate): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(update)));
}

export function subscribeQQPeerUpdates(listener: (update: QQPeerUpdate) => Promise<void>) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
