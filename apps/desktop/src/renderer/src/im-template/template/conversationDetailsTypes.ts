// @ts-nocheck
import type { Conversation } from './types';

export type GroupConversationView = Extract<Conversation, { type: 'group' }>;
