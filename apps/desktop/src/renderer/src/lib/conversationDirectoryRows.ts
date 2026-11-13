import { classifyChatType } from '@weq/codec';
import type { Conversation } from '../im-template/template/types';
import { resolveAvatar, avatarFromGroupCode } from './avatarResolver';
import { previewNodes, previewNodesToText } from './conversationPreview';

interface ProfileLike {
  nick?: string;
  remark?: string;
  qid?: string;
  uin?: string;
  avatarUrl?: string;
}
interface ArchivedSession {
  targetUid: string;
  targetUin?: string;
  chatType: string | number;
  sendTime: string;
  senderUid: string;
  preview?: unknown;
}
function isoTime(seconds: string): string {
  const value = Number(seconds);
  return new Date(Number.isFinite(value) && value > 0 ? value * 1000 : 0).toISOString();
}
export function archivedConversationRow(
  item: ArchivedSession,
  state: 'hidden' | 'deleted',
  profile?: ProfileLike,
  groupName?: string,
): Conversation {
  const group = classifyChatType(item.chatType) === 'group';
  const updatedAt = isoTime(item.sendTime);
  const base = {
    id: item.targetUid,
    directoryKind: 'qq' as const,
    hidden: state === 'hidden',
    deleted: state === 'deleted',
    updatedAt,
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    lastMessage: {
      id: `${state}:${item.targetUid}:${item.sendTime}`,
      senderId: item.senderUid,
      body: previewNodesToText(previewNodes(item.preview ?? null)),
      createdAt: updatedAt,
    },
  };
  if (group)
    return {
      ...base,
      type: 'group',
      otherUser: null,
      group: {
        id: item.targetUid,
        name: groupName || item.targetUid,
        identityLabel: 'Group',
        identityValue: item.targetUid,
        avatarUrl: avatarFromGroupCode(item.targetUid),
        announcement: null,
        memberCount: 0,
        role: 'member',
      },
      members: [],
    };
  const uin = item.targetUin && item.targetUin !== '0' ? item.targetUin : profile?.uin;
  return {
    ...base,
    type: 'direct',
    chatType: item.chatType,
    otherUser: {
      id: item.targetUid,
      identityLabel: uin ? 'QQ' : 'UID',
      identityValue: uin || item.targetUid,
      username: item.targetUid,
      displayName: profile?.remark || profile?.nick || profile?.qid || uin || item.targetUid,
      kind: 'human',
      avatarUrl: resolveAvatar({ uin, profileAvatarUrl: profile?.avatarUrl }),
    },
    group: null,
    members: [],
  };
}
export function feedConversationRow(
  item: {
    id: string;
    name: string;
    uin?: string;
    avatarUrl?: string | null;
    sendTime: string;
    prompt: string | null;
  },
  kind: 'official' | 'service',
): Conversation {
  const id = kind === 'service' ? `service:${item.id}` : item.id;
  const updatedAt = isoTime(item.sendTime);
  return {
    id,
    directoryKind: kind,
    type: 'direct',
    chatType: kind === 'official' ? 103 : 118,
    otherUser: {
      id: item.id,
      identityLabel: kind === 'official' ? 'QQ' : 'AppID',
      identityValue: item.uin || item.id,
      username: item.id,
      displayName: item.name || item.id,
      avatarUrl: resolveAvatar({ uin: item.uin, profileAvatarUrl: item.avatarUrl }),
    },
    group: null,
    members: [],
    updatedAt,
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    lastMessage: {
      id: `${id}:${item.sendTime}`,
      senderId: null,
      body: item.prompt,
      createdAt: updatedAt,
    },
  };
}
export function assistantConversationRow(item: {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
}): Conversation {
  return {
    id: `assistant:${item.id}`,
    directoryKind: 'assistant',
    generated: { kind: 'assistant', ownerId: 'assistant', sessionId: item.id },
    type: 'direct',
    otherUser: {
      id: `assistant:${item.id}`,
      identityLabel: '助手',
      identityValue: '',
      username: item.title,
      displayName: item.title,
      avatarUrl: null,
    },
    group: null,
    members: [],
    updatedAt: new Date(item.updatedAt).toISOString(),
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    lastMessage: {
      id: `assistant:${item.id}:preview`,
      senderId: null,
      body: item.running ? '正在回答…' : null,
      createdAt: new Date(item.updatedAt).toISOString(),
    },
  };
}
export function generatedAggregateRow(
  kind: 'clone' | 'assistant',
  rows: readonly Conversation[],
): Conversation {
  const latest = rows.reduce<Conversation | null>(
    (previous, row) =>
      !previous || Date.parse(row.updatedAt) > Date.parse(previous.updatedAt) ? row : previous,
    null,
  );
  return {
    id: `merged:${kind}`,
    type: 'merged',
    mergedKind: kind,
    title: kind === 'clone' ? '克隆会话' : 'WeQ 助手会话',
    avatarUrl: null,
    otherUser: null,
    group: null,
    members: [],
    updatedAt: latest?.updatedAt ?? '',
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    lastMessage: latest
      ? {
          id: `merged:${kind}:preview`,
          senderId: null,
          body: latest.type === 'direct' ? latest.otherUser.displayName : '',
          createdAt: latest.updatedAt,
        }
      : null,
  };
}
