import { createContext, type ReactNode } from 'react';
import type { User, GroupConversation } from '../im-template/template/types';

export type ProfileChatTarget =
  | { kind: 'direct'; user: User }
  | { kind: 'group'; conversation: GroupConversation };
export const ChatNavigationContext = createContext<((target: ProfileChatTarget) => void) | null>(
  null,
);

export const GroupMessagePreviewContext = createContext<{
  open: (conversation: GroupConversation) => void;
  close: () => void;
  conversationId: string | null;
  content: ReactNode;
} | null>(null);
