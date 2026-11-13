import { createContext } from 'react';
import type { Contact, GroupConversation } from '../im-template/template/types';
import type { GroupResourceRequest } from '../hooks/useGroupResourceWindows';

export interface ConversationSettingsRequest {
  kind: 'c2c' | 'group' | 'dataline';
  conv: string;
  title: string;
  anchor?: HTMLElement;
  initialSection?: 'qq' | 'group-management';
  groupConversation?: GroupConversation;
  contact?: Contact;
  onOpenProfile?: () => void;
}

export const ConversationSettingsNavigationContext = createContext<
  ((request: ConversationSettingsRequest) => void) | null
>(null);

export const GroupResourceNavigationContext = createContext<
  ((request: GroupResourceRequest) => boolean) | null
>(null);
