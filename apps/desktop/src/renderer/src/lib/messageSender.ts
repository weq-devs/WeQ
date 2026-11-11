import type { Conversation, GroupMember, User } from '../im-template/template/types';
import { avatarFromUin } from './avatarResolver';
import { isMineMessage } from './messageDirection';
import { displayGroupMemberName } from '../im-template/template/user';

type SenderMessage = { senderUid: string; senderUin: string; elements: readonly unknown[] };
export interface SenderProfile {
  remark?: string | null;
  nick?: string | null;
}
export type MemberUinLookup = (uin: string) => GroupMember | undefined;

/** 仅供同一批只读成员快照使用；首次需要 QQ 号回退时才建索引，重复号码沿用首项。 */
export function createMemberUinLookup(members: ReadonlyMap<string, GroupMember>): MemberUinLookup {
  let index: Map<string, GroupMember> | undefined;
  return (uin) => {
    if (!index) {
      index = new Map();
      for (const member of members.values()) {
        const key = member.uin;
        if (key && key !== '0' && !index.has(key)) index.set(key, member);
      }
    }
    return index.get(uin);
  };
}

function memberByUin(
  members: ReadonlyMap<string, GroupMember> | undefined,
  uin: string,
): GroupMember | undefined {
  for (const member of members?.values() ?? []) if (member.uin === uin) return member;
  return undefined;
}

/** 名片携带的云端名称不能覆盖会话中的本地名称。 */
export function localProfileUser(user: User, profile?: SenderProfile): User & SenderProfile {
  if (!profile) return user;
  return {
    ...user,
    remark: profile.remark,
    nick: profile.nick,
    displayName: profile.remark?.trim() || profile.nick?.trim() || user.identityValue || user.id,
  };
}

/** 群聊保留自己的群名片与等级；兼容只带 QQ 号的发送者。 */
export function messageSender(
  message: SenderMessage,
  conversation: Conversation,
  user: User,
  memberMap?: ReadonlyMap<string, GroupMember>,
  botUids?: ReadonlySet<string>,
  profiles?: ReadonlyMap<string, SenderProfile>,
  lookupByUin?: MemberUinLookup,
): User {
  const isMine = isMineMessage(message, conversation, user);
  if (isMine && conversation.type === 'direct') return user;
  if (conversation.type === 'group') {
    const member =
      memberMap?.get(message.senderUid) ??
      (isMine ? memberMap?.get(user.uid ?? '') : undefined) ??
      (message.senderUin && message.senderUin !== '0'
        ? lookupByUin
          ? lookupByUin(message.senderUin)
          : memberByUin(memberMap, message.senderUin)
        : undefined);
    const profile = profiles?.get(message.senderUid || member?.id || '');
    const remark = member?.remark?.trim() || profile?.remark?.trim();
    const nick = member?.nick?.trim() || profile?.nick?.trim();
    return {
      id: isMine ? user.id : message.senderUid || `sender:${message.senderUin}`,
      identityLabel: isMine
        ? user.identityLabel
        : message.senderUin && message.senderUin !== '0'
          ? 'QQ'
          : 'UID',
      identityValue: isMine
        ? user.identityValue
        : message.senderUin && message.senderUin !== '0'
          ? message.senderUin
          : message.senderUid,
      username: isMine ? user.username : message.senderUid || message.senderUin,
      card: member?.card,
      remark,
      nick,
      displayName:
        member?.card?.trim() && member.displayName
          ? member.displayName
          : displayGroupMemberName(
              member?.card,
              remark,
              nick,
              member?.displayName ||
                (isMine
                  ? user.displayName
                  : message.senderUin && message.senderUin !== '0'
                    ? message.senderUin
                    : message.senderUid || 'Member'),
            ),
      avatarUrl: isMine ? user.avatarUrl : member?.avatarUrl || avatarFromUin(message.senderUin),
      kind: !isMine && botUids?.has(message.senderUid) ? 'bot' : 'human',
      role: member?.role,
      customTitle: member?.customTitle,
      levelName: member?.levelName,
      memberLevel: member?.memberLevel,
    } as User;
  }
  if (isMine) return user;
  if (conversation.type !== 'direct') return user;
  const peer = conversation.otherUser;
  return localProfileUser(peer, profiles?.get(peer.uid || peer.id));
}

/** 乐观消息也使用群身份，但保留账号自身的稳定 senderId。 */
export function optimisticMessageSender(
  conversation: Conversation,
  user: User,
  members: ReadonlyMap<string, GroupMember>,
  lookupByUin?: MemberUinLookup,
): User {
  return messageSender(
    { senderUid: user.uid ?? user.id, senderUin: user.identityValue, elements: [] },
    conversation,
    user,
    members,
    undefined,
    undefined,
    lookupByUin,
  );
}

/** 展示快照仅用于解析历史发言人，不能当作当前群成员名单。 */
export function mergeMessageMembers<T extends { uid: string }>(
  previous: readonly T[],
  updates: readonly T[],
): T[] {
  return Array.from(
    new Map([...previous, ...updates].map((member) => [member.uid, member])).values(),
  );
}
