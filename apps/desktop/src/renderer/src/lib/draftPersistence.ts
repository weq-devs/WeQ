import type { SharedDraft } from '@weq/service/client-preferences';
import { accountBinding } from './clientPreferences';

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
    // 持续竞争时退避后继续，版本协调不交给用户重试。
    if (automaticRetries++ >= 3)
      await new Promise((resolve) => setTimeout(resolve, Math.min(automaticRetries * 100, 2000)));
    version = result.current.version;
  }
}
