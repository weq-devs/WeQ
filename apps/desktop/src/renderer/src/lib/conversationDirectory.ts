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
  locate?: { id: string; revision: number } | null;
  onVirtual: (item: VirtualConversation) => void;
  onCreate: () => void;
  onAnalyze?: (conversation: Conversation) => void;
  onAnalyzeMember?: (conversation: Extract<Conversation, { type: 'group' }>, member: User) => void;
  onRoaming?: (targets: RoamingTarget[]) => void;
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
