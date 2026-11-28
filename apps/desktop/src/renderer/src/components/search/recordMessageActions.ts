import type { Conversation, Message } from '../../im-template/template/types';

export type RecordMessageActions = {
  conversation: Conversation;
  sendBlockedReason?: string;
  quote?: (message: Message) => void;
  forward?: (messages: Message[]) => void;
  merge?: (messages: Message[]) => Promise<boolean>;
  addMaterial?: (messages: Message[]) => void;
};

export function recordMediaMessage(message: Message, elementIndex: number | undefined): Message {
  if (elementIndex === undefined) return message;
  const element = message.qqElements?.[elementIndex];
  return { ...message, qqElements: element ? [element] : [] };
}
