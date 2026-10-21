import { createContext } from 'react';
import type { Conversation, User } from '../im-template/template/types';
import type { RoamingTarget } from '@weq/service';

export interface VirtualConversation {
  id: string;
  kind: 'persona' | 'group';
  ownerId: string;
  name: string;
  uin?: string;
  /** 画像更新时间（毫秒）：没有任何会话时的兜底排序时间。 */
  updatedAt?: number;
  /** 最近一条消息的纯文本预览（来自最近的克隆会话）。 */
  preview?: string;
  /** 最近一条消息的时间（unix 秒），用于插入会话列表的正确位置。 */
  lastMessageTime?: number;
  /** 最近一条消息是不是自己发的（决定预览要不要加昵称前缀）。 */
  previewMine?: boolean;
  /** 克隆群成员的 QQ 号：用来拼九宫格合成头像。 */
  memberUins?: string[];
}
export const ConversationDirectoryContext = createContext<{
  virtual: VirtualConversation[];
  real?: Conversation[];
  /** 主会话列表始终排除这些群，完整目录搜索也不能绕过归属。 */
  groupAssistantIds?: ReadonlySet<string>;
  locate?: { id: string; revision: number } | null;
  onVirtual: (item: VirtualConversation) => void;
  /** 新建好友克隆（支持批量：一次性把多个好友交给 AgentLab）。 */
  onCreate: (friendUids?: string[]) => void;
  /** 新建克隆体群聊：直接打开多选克隆体的建群弹窗。 */
  onCreateGroup?: () => void;
  onAnalyze?: (conversation: Conversation) => void;
  onPin?: (conversation: Conversation, pinned: boolean) => void;
  onEditRemark?: (conversation: Conversation) => void;
  loadingError?: string;
  onAnalyzeMember?: (conversation: Extract<Conversation, { type: 'group' }>, member: User) => void;
  onRoaming?: (targets: RoamingTarget[]) => void;
  onReadState?: (conversations: Conversation[], unread: boolean) => void;
  readStateBusy?: boolean;
} | null>(null);

export const ContactDirectoryContext = createContext<{
  query: string;
  onQuery: (value: string) => void;
  ids: string[];
} | null>(null);

/**
 * 克隆体的列表时间（unix 秒）：优先最后一条消息；没有消息时退回画像更新时间。
 *
 * 注意单位：`updatedAt` 是毫秒，`lastMessageTime` 是秒。之前直接 `??` 混用，
 * 刚建好、还没有消息的克隆体会拿到一个「秒」量级的十几倍大数字，被排到最前面。
 */
export function virtualConversationTime(item: VirtualConversation): number {
  if (item.lastMessageTime) return item.lastMessageTime;
  return item.updatedAt ? Math.round(item.updatedAt / 1000) : 0;
}

export function virtualConversationRow(item: VirtualConversation): Conversation {
  const seconds = virtualConversationTime(item);
  const updatedAt = seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
  return {
    id: item.id,
    type: 'direct',
    otherUser: {
      id: item.id,
      identityLabel: '虚拟',
      identityValue: item.uin ?? '',
      username: item.name,
      displayName: item.name,
      avatarUrl: item.uin
        ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(item.uin)}&s=100`
        : null,
    },
    group: null,
    members: [],
    updatedAt,
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    // 让列表行直接显示最近一句；没有记录时才留空。
    lastMessage: item.preview
      ? {
          id: `${item.id}:preview`,
          senderId: item.previewMine ? null : item.ownerId,
          senderDisplayName: item.previewMine ? '我' : item.name,
          body: item.preview,
          kind: 'text',
          createdAt: updatedAt || undefined,
        }
      : null,
  };
}
