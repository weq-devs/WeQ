import { create } from 'zustand';
import type { SharedDraft } from '@weq/service/client-preferences';
import { accountBinding } from './clientPreferences';

export type DraftChoice = 'local' | 'remote' | 'copy' | 'cancel';
interface Conflict {
  key: string;
  local: unknown;
  remote: SharedDraft;
  resolve: (choice: DraftChoice) => void;
}
export const useDraftConflict = create<{
  requests: Conflict[];
  copiesCount: number;
  copiesOpen: number;
}>(() => ({ requests: [], copiesCount: 0, copiesOpen: 0 }));
export function openDraftCopies() {
  useDraftConflict.setState((state) => ({ copiesOpen: state.copiesOpen + 1 }));
}
export function chooseDraft(choice: DraftChoice) {
  const [current, ...requests] = useDraftConflict.getState().requests;
  useDraftConflict.setState({ requests });
  current?.resolve(choice);
}
export async function resolveDraftSave(
  key: string,
  value: unknown,
  expectedVersion: string | null,
  save: (version: string | null) => Promise<{ ok: boolean; current: SharedDraft }>,
): Promise<{ current: SharedDraft; local: boolean }> {
  const expectedBinding = JSON.stringify(accountBinding());
  let version = expectedVersion;
  for (;;) {
    if (JSON.stringify(accountBinding()) !== expectedBinding)
      throw new Error('账号已切换，原草稿已保留');
    const result = await save(version);
    if (JSON.stringify(accountBinding()) !== expectedBinding)
      throw new Error('账号已切换，原草稿已保留');
    if (result.ok) return { current: result.current, local: true };
    const choice = await new Promise<DraftChoice>((resolve) =>
      useDraftConflict.setState((state) => ({
        requests: [...state.requests, { key, local: value, remote: result.current, resolve }],
      })),
    );
    if (JSON.stringify(accountBinding()) !== expectedBinding)
      throw new Error('账号已切换，原草稿已保留');
    if (choice === 'cancel') throw new Error('草稿冲突尚未处理，本机恢复快照已保留');
    if (choice === 'remote') return { current: result.current, local: false };
    if (choice === 'copy') {
      const binding = accountBinding();
      if (!binding) throw new Error('账号已切换，本机草稿已保留');
      const { client } = await import('../trpc/client');
      const copyKey = `copy:${crypto.randomUUID()}`;
      const resultCopy = await client.clientState.saveDraft.mutate({
        ...binding,
        key: copyKey,
        value: { source: key, content: value, createdAt: Date.now() },
        expectedVersion: null,
      });
      if (!resultCopy.ok) throw new Error('草稿副本未保存，请重试');
      openDraftCopies();
      return { current: result.current, local: false };
    }
    version = result.current.version;
  }
}
