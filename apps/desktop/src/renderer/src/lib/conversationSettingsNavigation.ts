import { createContext } from 'react';
import type { DressConversationSlot } from '@weq/service';
import type { GroupConversation } from '../im-template/template/types';
import type { GroupResourceRequest } from '../hooks/useGroupResourceWindows';

export type ConversationSettingsSection =
  | 'qq'
  | 'group-management'
  | 'antirecall'
  | 'keyword'
  | 'intentsense'
  | 'dress';

export interface ConversationSettingsRequest {
  kind: 'c2c' | 'group' | 'dataline';
  conv: string;
  title: string;
  anchor?: HTMLElement;
  initialSection?: ConversationSettingsSection;
  initialDressSlot?: DressConversationSlot;
  groupConversation?: GroupConversation;
}

export const ConversationSettingsNavigationContext = createContext<
  ((request: ConversationSettingsRequest) => void) | null
>(null);

export const GroupResourceNavigationContext = createContext<
  ((request: GroupResourceRequest) => boolean) | null
>(null);
