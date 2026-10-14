import { createContext } from 'react';
import type { User, GroupConversation } from '../im-template/template/types';

export type ProfileChatTarget =
  | { kind: 'direct'; user: User }
  | { kind: 'group'; conversation: GroupConversation };
export const ChatNavigationContext = createContext<((target: ProfileChatTarget) => void) | null>(
  null,
);
