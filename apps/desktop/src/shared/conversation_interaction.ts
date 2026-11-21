export interface ConversationInteraction {
  kind: 'c2c' | 'group';
  conv: string;
  msgId: string;
  action: 'poke' | 'recall' | 'seqless';
  bannerPending?: true;
  storedWithoutSeq?: true;
}

export interface ConversationInteractionSnapshot {
  pending: ConversationInteraction[];
  badges: ConversationInteraction[];
  seen: readonly string[];
}

export function conversationInteractionId(event: ConversationInteraction): string {
  return JSON.stringify([event.kind, event.conv, event.msgId, event.action]);
}

export const interactionBannerPrefix = (uin: string, configId: string) =>
  `${JSON.stringify(['interaction', uin, configId])}:`;
