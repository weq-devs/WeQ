import { create } from 'zustand';
import type { SharedDraft } from '@weq/service/client-preferences';
import { accountBinding } from './clientPreferences';

export const useDraftCopies = create<{
  copiesCount: number;
  copiesOpen: number;
}>(() => ({ copiesCount: 0, copiesOpen: 0 }));
export function openDraftCopies() {
  useDraftCopies.setState((state) => ({ copiesOpen: state.copiesOpen + 1 }));
}
type DraftSaveResult = { current: SharedDraft; local: boolean };
const pendingSaves = new Map<string, Promise<DraftSaveResult>>();

export async function resolveDraftSave(
  key: string,
  value: unknown,
  expectedVersion: string | null,
  save: (version: string | null) => Promise<{ ok: boolean; current: SharedDraft }>,
): Promise<DraftSaveResult> {
  const expectedBinding = JSON.stringify(accountBinding());
  const queueKey = JSON.stringify([expectedBinding, key]);
  const previous = pendingSaves.get(queueKey);
  const pending = (async () => {
    const preceding = await previous?.catch(() => undefined);
    return saveDraftAutomatically(
      key,
      value,
      preceding?.current.version ?? expectedVersion,
      save,
      expectedBinding,
    );
  })();
  pendingSaves.set(queueKey, pending);
  try {
    return await pending;
  } finally {
    if (pendingSaves.get(queueKey) === pending) pendingSaves.delete(queueKey);
  }
}

async function saveDraftAutomatically(
  key: string,
  value: unknown,
  expectedVersion: string | null,
  save: (version: string | null) => Promise<{ ok: boolean; current: SharedDraft }>,
  expectedBinding: string,
): Promise<DraftSaveResult> {
  let version = expectedVersion;
  let automaticRetries = 0;
  const preservedVersions = new Set<string | null>();
  for (;;) {
    if (JSON.stringify(accountBinding()) !== expectedBinding)
      throw new Error('账号已切换，原草稿已保留');
    const result = await save(version);
    if (JSON.stringify(accountBinding()) !== expectedBinding)
      throw new Error('账号已切换，原草稿已保留');
    if (result.ok) return { current: result.current, local: true };
    // 重复保存（包括重复清空）不应要求用户处理版本差异。
    if (
      JSON.stringify(result.current.value) === JSON.stringify(value) ||
      (key.startsWith('chat:') &&
        result.current.value === null &&
        Array.isArray(value) &&
        !value.length)
    )
      return { current: result.current, local: true };
    {
      // 持续竞争时退避后继续，版本协调不交给用户重试。
      if (automaticRetries++ >= 3)
        await new Promise((resolve) => setTimeout(resolve, Math.min(automaticRetries * 100, 2000)));
      const binding = accountBinding();
      if (!binding || JSON.stringify(binding) !== expectedBinding)
        throw new Error('账号已切换，原草稿已保留');
      const { client } = await import('../trpc/client');
      if (JSON.stringify(accountBinding()) !== expectedBinding)
        throw new Error('账号已切换，原草稿已保留');
      // 先落副本再尝试覆盖；复制失败时不改变共享稿或本机恢复快照。
      if (result.current.value !== null && !preservedVersions.has(result.current.version)) {
        const copy = await client.clientState.saveDraft.mutate({
          ...binding,
          key: `copy:${crypto.randomUUID()}`,
          value: { source: key, content: result.current.value, createdAt: Date.now() },
          expectedVersion: null,
        });
        if (!copy.ok) throw new Error('草稿副本未保存，请重试');
        preservedVersions.add(result.current.version);
      }
      version = result.current.version;
    }
  }
}
