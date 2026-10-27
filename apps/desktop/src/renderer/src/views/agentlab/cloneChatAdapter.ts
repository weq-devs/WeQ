import type { Conversation, GroupMember, Message, User } from '../../im-template/template/types';
import { qqAvatarUrl } from '../../components/QqAvatar';
import { parseMessageParts } from '../../im-template/template/emojiPacks';
import { tokenToElement } from '../../im-template/template/draftElements';
import type { GeneratedContentIdentity } from '../../../../shared/content_selection';

/** 只投影数据，不定义另一套聊天页面或伪造 QQ 消息序号。 */
export function cloneChatUser(id: string, name: string, uin?: string, clone = false): User {
  return {
    id: `virtual:${id}`,
    identityLabel: clone ? '克隆体' : '',
    identityValue: clone ? `virtual:${id}` : uin || `virtual:${id}`,
    username: name,
    displayName: name,
    avatarUrl: uin ? qqAvatarUrl(uin) : null,
    clone,
  };
}

export function cloneChatConversation({
  target,
  viewId,
  name,
  peer,
  members = [],
}: {
  target: GeneratedContentIdentity;
  viewId: string;
  name: string;
  peer: User;
  members?: User[];
}): Conversation {
  const base = { id: viewId, generated: target, updatedAt: '', lastMessage: null };
  return target.kind === 'group'
    ? {
        ...base,
        type: 'group',
        otherUser: null,
        group: {
          id: viewId,
          identityLabel: '',
          identityValue: viewId,
          name,
          avatarUrl: null,
          announcement: null,
          memberCount: members.length,
          role: 'member',
        },
        members: members.map(
          (member): GroupMember => ({
            ...member,
            nick: member.displayName,
            role: 'member',
            joinedAt: '',
          }),
        ),
      }
    : { ...base, type: 'direct', otherUser: peer, group: null, members: [] };
}

export function cloneChatMessages(
  rows: readonly { id?: string; text: string; ts: number }[],
  conversationId: string,
  senderFor: (index: number) => User,
): Message[] {
  return rows.map((row, index) => {
    const sender = senderFor(index);
    const date = new Date(row.ts);
    return {
      id: row.id || `pending-clone:${index}`,
      generatedPending: !row.id,
      conversationId,
      senderId: sender.id,
      sender,
      body: row.text,
      createdAt: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString(),
    };
  });
}

/** 普通输入框的结构化文本、表情和提及转换为克隆后端当前接受的文本。 */
export function cloneChatInput(body: string, faceNames: ReadonlyMap<string, number>): string {
  const names = new Map([...faceNames].map(([name, id]) => [String(id), name]));
  return parseMessageParts(body)
    .map((part) => {
      if (part.type === 'text') return part.value;
      if (part.type === 'emoji' && part.item.kind === 'system' && !part.item.large)
        return `/${names.get(part.item.id) || part.item.name}`;
      if (part.type === 'emoji' && part.item.kind === 'unicode')
        return part.item.glyph || part.item.name;
      if (part.type === 'element') {
        const element = tokenToElement(part.raw);
        if (
          element &&
          typeof element === 'object' &&
          'kind' in element &&
          element.kind === 'at' &&
          'textContent' in element &&
          typeof element.textContent === 'string'
        )
          return element.textContent;
      }
      throw new Error('克隆会话暂不支持这种消息内容，请使用文字或系统表情。');
    })
    .join('');
}
