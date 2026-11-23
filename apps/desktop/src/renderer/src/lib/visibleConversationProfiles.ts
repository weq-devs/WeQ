import { classifyChatType } from '@weq/codec';
import { previewIdentityIds } from './conversationPreview';
import { displayGroupMemberName } from '../im-template/template/user';

type NameIndex = Pick<ReadonlyMap<string, string>, 'get'>;
export type GroupPreviewNameIndex = Pick<ReadonlyMap<string, NameIndex>, 'get'>;

interface PreviewMember {
  uid: string;
  uin: string;
  card: string;
  nick: string;
}

const membersByUin = new WeakMap<
  Readonly<Record<string, PreviewMember>>,
  Map<string, PreviewMember>
>();

/** 预览只查引用的名字。QQ 号索引仅在该群第一次按号码查找时建立。 */
export function groupPreviewNameIndex(
  groups: Readonly<Record<string, Readonly<Record<string, PreviewMember>>>>,
  profiles: ReadonlyMap<string, { remark?: string | null; nick?: string | null }>,
): GroupPreviewNameIndex {
  const indexes = new Map<string, NameIndex>();
  const names = new WeakMap<PreviewMember, string>();
  return {
    get(group) {
      const members = Object.hasOwn(groups, group) ? groups[group] : undefined;
      if (!members) return undefined;
      let index = indexes.get(group);
      if (!index) {
        index = {
          get(id) {
            let member = Object.hasOwn(members, id) ? members[id] : undefined;
            if (!member && /^[1-9]\d*$/.test(id)) {
              let numbers = membersByUin.get(members);
              if (!numbers) {
                numbers = new Map();
                for (const row of Object.values(members)) {
                  if (row.uin && row.uin !== '0') numbers.set(row.uin, row);
                }
                membersByUin.set(members, numbers);
              }
              member = numbers.get(id);
            }
            if (!member) return undefined;
            let name = names.get(member);
            if (name === undefined) {
              const profile = profiles.get(member.uid);
              name = displayGroupMemberName(
                member.card,
                profile?.remark,
                member.nick || profile?.nick,
                member.uin || member.uid,
              );
              names.set(member, name);
            }
            return name || undefined;
          },
        };
        indexes.set(group, index);
      }
      return index;
    },
  };
}

interface ProfileContact {
  targetUid: string;
  senderUid: string;
  chatType: string | number;
  preview: unknown;
}

export function selectProfileContacts<T extends ProfileContact>(
  rowsByUid: ReadonlyMap<string, T>,
  visibleIds: readonly string[],
): T[] {
  const rows: T[] = [];
  for (const id of new Set(visibleIds)) {
    const row = rowsByUid.get(id);
    if (row) rows.push(row);
  }
  return rows;
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
