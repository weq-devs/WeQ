import type { GeneratedMessage, GeneratedSearchSources } from './generated_search';

export interface GeneratedContentTarget {
  kind: 'persona' | 'group' | 'assistant';
  ownerId: string;
  /** 克隆长期对话使用 null；助手始终有独立 sessionId。 */
  sessionId: string | null;
}

export interface GeneratedConversation extends GeneratedContentTarget {
  title: string;
  sessionTitle: string;
  count: number;
}

export interface GeneratedContentSnapshot {
  origin: 'local-generated';
  target: GeneratedContentTarget;
  title: string;
  sessionTitle: string;
  capturedAt: number;
  /** undefined 为整场持久对话；空数组为显式空集合。 */
  selectedIds?: string[];
  messages: Array<
    GeneratedMessage & {
      id: string;
      sourceSessionId?: string | null;
      sourceSessionTitle?: string;
      sourceMessageId?: string;
      sourceReplyToId?: string;
    }
  >;
}

/** 列表只读账号持久记录，不创建会话或调用模型。 */
export function listGeneratedConversations(
  sources: GeneratedSearchSources,
): GeneratedConversation[] {
  const entries: GeneratedConversation[] = [];
  for (const [kind, owners] of [
    ['persona', sources.agentLab.listPersonas()],
    ['group', sources.agentLab.listGroups()],
  ] as const) {
    for (const owner of owners) {
      const messages =
        kind === 'persona'
          ? sources.agentLab.getConversation(owner.id)
          : sources.agentLab.getGroupMessages(owner.id);
      entries.push({
        kind,
        ownerId: owner.id,
        sessionId: null,
        title: owner.name,
        sessionTitle: '长期对话',
        count: messages.length,
      });
    }
  }
  for (const session of sources.assistant.listSessions())
    entries.push({
      kind: 'assistant',
      ownerId: 'assistant',
      sessionId: session.id,
      title: 'WeQ 助手',
      sessionTitle: session.title,
      count: sources.assistant.getConversation(session.id).length,
    });
  return entries;
}

/** 在确认边界复制精确集合与正文；之后删除源会话、补答或切号不改写任务。 */
export function captureGeneratedContent(
  sources: GeneratedSearchSources,
  target: GeneratedContentTarget,
  selectedIds?: readonly string[],
): GeneratedContentSnapshot {
  let messages: GeneratedMessage[];
  let title: string;
  let sessionTitle: string;
  if (target.kind === 'assistant') {
    const session = sources.assistant.listSessions().find((item) => item.id === target.sessionId);
    if (target.ownerId !== 'assistant' || !session) throw new Error('助手会话不存在或已删除。');
    messages = sources.assistant
      .getConversation(session.id)
      .filter((message) => message.status !== 'running');
    title = 'WeQ 助手';
    sessionTitle = session.title;
  } else {
    const persona = target.kind === 'persona';
    const owner = (persona ? sources.agentLab.listPersonas() : sources.agentLab.listGroups()).find(
      (item) => item.id === target.ownerId,
    );
    if (!owner) throw new Error('克隆对象不存在或已删除。');
    title = owner.name;
    messages = persona
      ? sources.agentLab.getConversation(owner.id)
      : sources.agentLab.getGroupMessages(owner.id);
    sessionTitle = '长期对话';
  }
  const wanted = selectedIds === undefined ? undefined : new Set(selectedIds);
  if (wanted) {
    const available = new Set(messages.map((message) => message.id));
    const missing = [...wanted].filter((id) => !available.has(id));
    if (missing.length)
      throw new Error(`${missing.length} 条选中记录不存在或尚未持久化，请刷新后重新选择。`);
  }
  const selected = wanted
    ? messages.filter((message) => message.id && wanted.has(message.id))
    : messages;
  if (selected.some((message) => !message.id))
    throw new Error('记录缺少稳定身份，无法创建精确导出快照。');
  return structuredClone({
    origin: 'local-generated',
    target: target.kind === 'assistant' ? target : { ...target, sessionId: null },
    title,
    sessionTitle,
    capturedAt: Date.now(),
    ...(wanted ? { selectedIds: [...wanted] } : {}),
    messages: selected as Array<GeneratedMessage & { id: string }>,
  });
}
