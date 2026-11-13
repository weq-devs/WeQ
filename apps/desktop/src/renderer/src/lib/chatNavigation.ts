import { createContext, type ReactNode } from 'react';
import type { User, GroupConversation } from '../im-template/template/types';
import type { ProfilePerson } from '../hooks/useContactCard';

export type ProfileChatTarget =
  | { kind: 'direct'; user: User }
  | { kind: 'group'; conversation: GroupConversation };
export const ChatNavigationContext = createContext<((target: ProfileChatTarget) => void) | null>(
  null,
);

export const ProfilePreviewSourceContext = createContext<'member' | 'contact'>('member');
export const GroupSpeechPreviewContext = createContext<{
  open: (person: ProfilePerson, source: 'member' | 'contact') => void;
  close: () => void;
} | null>(null);

export const GroupMessagePreviewContext = createContext<{
  open: (conversation: GroupConversation) => void;
  close: () => void;
  conversationId: string | null;
  content: ReactNode;
} | null>(null);
