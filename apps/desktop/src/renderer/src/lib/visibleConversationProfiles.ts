import { classifyChatType } from '@weq/codec';
import { previewIdentityIds } from './conversationPreview';

interface ProfileContact {
  targetUid: string;
  senderUid: string;
  chatType: string | number;
  preview: unknown;
}

export function selectProfileContacts<T extends ProfileContact>(
  rows: readonly T[],
  visibleIds?: readonly string[],
): readonly T[] {
  if (!visibleIds) return rows;
  const visible = new Set(visibleIds);
  return rows.filter((row) => visible.has(row.targetUid));
}

/** 对方身份和灰条涉及的用户一起批量补全；群名片始终按群隔离。 */
export function conversationProfileTargets(rows: readonly ProfileContact[]) {
  const uids = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const ids = previewIdentityIds(row.preview, row.senderUid).filter((id) => id.startsWith('u_'));
    for (const id of ids) uids.add(id);
    const kind = classifyChatType(row.chatType);
    if (kind === 'direct' && row.targetUid.startsWith('u_')) uids.add(row.targetUid);
    if (kind === 'group' && /^\d+$/.test(row.targetUid)) groups.set(row.targetUid, ids);
  }
  return { uids: [...uids], groups };
}
