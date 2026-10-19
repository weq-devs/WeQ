import { createContext } from 'react';
import type { Conversation, User } from '../im-template/template/types';
import type { RoamingTarget } from '@weq/service';

export interface VirtualConversation {
  id: string;
  kind: 'persona' | 'group';
  ownerId: string;
  name: string;
  uin?: string;
  updatedAt?: number;
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

export function virtualConversationRow(item: VirtualConversation): Conversation {
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
    updatedAt: new Date(item.updatedAt ?? 0).toISOString(),
    preference: { pinned: false, muted: false, blocked: false },
    unreadCount: 0,
    lastMessage: null,
  };
}
