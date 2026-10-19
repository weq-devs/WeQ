import { coerceDraft, type MfDraft } from './model';
import type { CompositionBinding } from './workspaceModel';

function prefix(binding: CompositionBinding): string {
  return `weq:composition-recovery:${encodeURIComponent(JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId]))}:`;
}
function key(binding: CompositionBinding, draft: MfDraft): string {
  return `${prefix(binding)}${encodeURIComponent(draft.id)}`;
}
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          )
        : item,
    ) ?? 'null'
  );
}

/** 只备份草稿元数据，不复制媒体；旧保存回执不能删除较新的本机编辑。 */
export function backupComposition(
  binding: CompositionBinding,
  draft: MfDraft,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(key(binding, draft), canonical(draft));
}
export function acknowledgeCompositionBackup(
  binding: CompositionBinding,
  draft: MfDraft,
  storage: Storage = window.localStorage,
): void {
  const name = key(binding, draft);
  const raw = storage.getItem(name);
  if (raw !== null && canonical(JSON.parse(raw) as unknown) === canonical(draft))
    storage.removeItem(name);
}
export function readCompositionBackups(
  binding: CompositionBinding,
  storage: Storage = window.localStorage,
): { drafts: MfDraft[]; damaged: number } {
  const drafts: MfDraft[] = [];
  let damaged = 0;
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(prefix(binding))) continue;
    try {
      const raw: unknown = JSON.parse(storage.getItem(name) ?? 'null');
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('id' in raw) ||
        typeof raw.id !== 'string' ||
        !('title' in raw) ||
        typeof raw.title !== 'string' ||
        !('createdAt' in raw) ||
        !Number.isFinite(raw.createdAt) ||
        !('updatedAt' in raw) ||
        !Number.isFinite(raw.updatedAt) ||
        !('nodes' in raw) ||
        !Array.isArray(raw.nodes)
      )
        throw new Error('invalid draft');
      const draft = coerceDraft(raw as Parameters<typeof coerceDraft>[0]);
      if (
        draft.nodes.some(
          (node) =>
            !node.sender ||
            typeof node.sender.name !== 'string' ||
            typeof node.sender.uid !== 'string' ||
            typeof node.sender.uin !== 'string' ||
            !Number.isFinite(node.time),
        )
      )
        throw new Error('invalid nodes');
      drafts.push(draft);
    } catch {
      damaged += 1;
    }
  }
  return { drafts: drafts.sort((a, b) => b.updatedAt - a.updatedAt), damaged };
}
