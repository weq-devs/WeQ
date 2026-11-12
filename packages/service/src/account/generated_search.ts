export type GeneratedSearchCategory = 'cloneMessage' | 'assistantMessage';

export interface GeneratedSearchHit {
  category: GeneratedSearchCategory;
  kind: 'persona' | 'group' | 'assistant';
  ownerId: string;
  /** null 表示克隆的长期对话（兼容旧单桶），不表示新建草稿。 */
  sessionId: string | null;
  messageId: string;
  title: string;
  sessionTitle: string;
  content: string;
  ts: number;
  /** 标题命中不带消息锚点，直接打开对应独立会话。 */
  matchType?: 'title' | 'content';
}

export interface GeneratedSearchSources {
  agentLab: {
    listPersonas(): Array<{ id: string; name: string }>;
    listGroups(): Array<{ id: string; name: string }>;
    listPersonaSessions(id: string): Array<{ id: string; title: string }>;
    getPersonaSessionConversation(id: string, sessionId: string): GeneratedMessage[];
    getConversation(id: string): GeneratedMessage[];
    listGroupSessions(id: string): Array<{ id: string; title: string }>;
    getGroupSessionConversation(id: string, sessionId: string): GeneratedMessage[];
    getGroupMessages(id: string): GeneratedMessage[];
  };
  assistant: {
    listSessions(): Array<{ id: string; title: string; updatedAt?: number }>;
    getConversation(sessionId: string): GeneratedMessage[];
  };
}

export interface GeneratedMessage {
  id?: string;
  text: string;
  ts: number;
  role?: 'user' | 'assistant';
  senderId?: string;
  senderKind?: 'user' | 'persona';
  toolsUsed?: string[];
  steps?: unknown[];
  actions?: unknown[];
  replyToId?: string;
  mentions?: string[];
}

/** 仅遍历当前账号的内存态持久化记录，不调用模型、网络或创建会话。 */
export function searchGeneratedMessages(
  sources: GeneratedSearchSources,
  category: GeneratedSearchCategory,
  keyword: string,
): GeneratedSearchHit[] {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits: GeneratedSearchHit[] = [];
  const add = (
    target: Pick<GeneratedSearchHit, 'kind' | 'ownerId' | 'sessionId' | 'title' | 'sessionTitle'>,
    messages: Array<{ id?: string; text: string; ts: number }>,
  ) => {
    for (const message of messages) {
      if (!message.id || !message.text.toLocaleLowerCase().includes(needle)) continue;
      const at = message.text.toLocaleLowerCase().indexOf(needle);
      const start = Math.max(0, at - 48);
      hits.push({
        category,
        ...target,
        messageId: message.id,
        content: `${start ? '…' : ''}${message.text.slice(start, Math.max(start + 200, at + needle.length))}${message.text.length > Math.max(start + 200, at + needle.length) ? '…' : ''}`,
        ts: message.ts,
        matchType: 'content',
      });
    }
  };
  if (category === 'assistantMessage') {
    for (const session of sources.assistant.listSessions()) {
      const messages = sources.assistant.getConversation(session.id);
      if (session.title.toLocaleLowerCase().includes(needle))
        hits.push({
          category,
          kind: 'assistant',
          ownerId: 'assistant',
          sessionId: session.id,
          messageId: '',
          title: 'WeQ 助手',
          sessionTitle: session.title,
          content: session.title,
          ts: session.updatedAt ?? messages.at(-1)?.ts ?? 0,
          matchType: 'title',
        });
      add(
        {
          kind: 'assistant',
          ownerId: 'assistant',
          sessionId: session.id,
          title: 'WeQ 助手',
          sessionTitle: session.title,
        },
        messages,
      );
    }
  } else {
    for (const persona of sources.agentLab.listPersonas()) {
      const target = { kind: 'persona' as const, ownerId: persona.id, title: persona.name };
      add(
        { ...target, sessionId: null, sessionTitle: '长期对话' },
        sources.agentLab.getConversation(persona.id),
      );
      for (const session of sources.agentLab.listPersonaSessions(persona.id)) {
        add(
          { ...target, sessionId: session.id, sessionTitle: session.title },
          sources.agentLab.getPersonaSessionConversation(persona.id, session.id),
        );
      }
    }
    for (const group of sources.agentLab.listGroups()) {
      const target = { kind: 'group' as const, ownerId: group.id, title: group.name };
      add(
        { ...target, sessionId: null, sessionTitle: '长期对话' },
        sources.agentLab.getGroupMessages(group.id),
      );
      for (const session of sources.agentLab.listGroupSessions(group.id)) {
        add(
          { ...target, sessionId: session.id, sessionTitle: session.title },
          sources.agentLab.getGroupSessionConversation(group.id, session.id),
        );
      }
    }
  }
  return hits.sort((a, b) => b.ts - a.ts || a.messageId.localeCompare(b.messageId));
}
