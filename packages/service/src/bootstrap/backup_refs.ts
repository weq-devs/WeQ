function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const WEQ_CLONE_STORES: ReadonlySet<string> = new Set([
  'usage.json',
  'conversations.json',
  'memories.json',
  'notes.json',
  'groups.json',
  'relations.json',
  'sessions.json',
  'group_session_messages.json',
  'assistant.json',
  'assistant_sessions.json',
]);

export function weqClonePersona(value: unknown, storeName: string): Record<string, unknown> | null {
  if (WEQ_CLONE_STORES.has(storeName) || !storeName.endsWith('.json') || !record(value))
    return null;
  return record(value.persona) ? value.persona : null;
}

/** 只访问真实存储中的类型化资产槽位，不遍历替换对话文本或模型上下文。 */
export function weqCloneStickerReferences(
  value: unknown,
  storeName: string,
): Record<string, unknown>[] {
  if (!record(value)) return [];
  const references: Record<string, unknown>[] = [];
  const persona = weqClonePersona(value, storeName);
  if (persona && persona.stickers !== undefined) {
    if (!Array.isArray(persona.stickers)) throw new Error('克隆表情引用结构无效');
    for (const sticker of persona.stickers) {
      if (!record(sticker)) throw new Error('克隆表情引用结构无效');
      references.push(sticker);
    }
  }
  const messages =
    storeName === 'groups.json'
      ? value.messages
      : storeName === 'group_session_messages.json'
        ? value
        : undefined;
  if (record(messages))
    for (const bucket of Object.values(messages)) {
      if (!Array.isArray(bucket)) continue;
      for (const message of bucket) {
        if (!record(message) || message.actions === undefined) continue;
        if (!Array.isArray(message.actions)) throw new Error('克隆群聊动作结构无效');
        for (const action of message.actions)
          if (record(action) && action.kind === 'sticker') {
            if (!record(action.sticker)) throw new Error('克隆群聊表情引用结构无效');
            references.push(action.sticker);
          }
      }
    }
  return references;
}
