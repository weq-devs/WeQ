import type { Conversation, GroupMember, User } from '../im-template/template/types';
import { avatarFromUin } from './avatarResolver';
import { isMineMessage } from './messageDirection';

type SenderMessage = { senderUid: string; senderUin: string; elements: readonly unknown[] };

/** 群聊保留自己的群名片与等级；兼容只带 QQ 号的发送者。 */
export function messageSender(
  message: SenderMessage,
  conversation: Conversation,
  user: User,
  memberMap?: ReadonlyMap<string, GroupMember>,
  botUids?: ReadonlySet<string>,
): User {
  const isMine = isMineMessage(message, conversation, user);
  if (isMine && conversation.type === 'direct') return user;
  if (conversation.type === 'group') {
    const member =
      memberMap?.get(message.senderUid) ??
      (isMine ? memberMap?.get(user.uid ?? '') : undefined) ??
      (message.senderUin && message.senderUin !== '0'
        ? Array.from(memberMap?.values() ?? []).find((m) => m.uin === message.senderUin)
        : undefined);
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
      remark: member?.remark,
      nick: member?.nick,
      displayName:
        member?.displayName ||
        (isMine
          ? user.displayName
          : message.senderUin && message.senderUin !== '0'
            ? message.senderUin
            : 'Member'),
      avatarUrl: isMine ? user.avatarUrl : member?.avatarUrl || avatarFromUin(message.senderUin),
      kind: !isMine && botUids?.has(message.senderUid) ? 'bot' : 'human',
      role: member?.role,
      customTitle: member?.customTitle,
      levelName: member?.levelName,
      memberLevel: member?.memberLevel,
    } as User;
  }
  if (isMine) return user;
  return conversation.type === 'direct' ? conversation.otherUser : user;
}

/** 乐观消息也使用群身份，但保留账号自身的稳定 senderId。 */
export function optimisticMessageSender(
  conversation: Conversation,
  user: User,
  members: ReadonlyMap<string, GroupMember>,
): User {
  return messageSender(
    { senderUid: user.uid ?? user.id, senderUin: user.identityValue, elements: [] },
    conversation,
    user,
    members,
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
