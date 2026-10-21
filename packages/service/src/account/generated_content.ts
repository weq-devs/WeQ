import type { GeneratedMessage, GeneratedSearchSources } from './generated_search';

export interface GeneratedContentTarget {
  kind: 'persona' | 'group' | 'assistant';
  ownerId: string;
  /** null 仅表示旧版克隆记录；助手始终有实际 sessionId。 */
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
  messages: Array<GeneratedMessage & { id: string }>;
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
      const sessions =
        kind === 'persona'
          ? sources.agentLab.listPersonaSessions(owner.id)
          : sources.agentLab.listGroupSessions(owner.id);
      const legacy =
        kind === 'persona'
          ? sources.agentLab.getConversation(owner.id)
          : sources.agentLab.getGroupMessages(owner.id);
      if (legacy.length)
        entries.push({
          kind,
          ownerId: owner.id,
          sessionId: null,
          title: owner.name,
          sessionTitle: '旧版对话',
          count: legacy.length,
        });
      for (const session of sessions) {
        const rows =
          kind === 'persona'
            ? sources.agentLab.getPersonaSessionConversation(owner.id, session.id)
            : sources.agentLab.getGroupSessionConversation(owner.id, session.id);
        entries.push({
          kind,
          ownerId: owner.id,
          sessionId: session.id,
          title: owner.name,
          sessionTitle: session.title,
          count: rows.length,
        });
      }
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
    messages = sources.assistant.getConversation(session.id);
    title = 'WeQ 助手';
    sessionTitle = session.title;
  } else {
    const persona = target.kind === 'persona';
    const owner = (persona ? sources.agentLab.listPersonas() : sources.agentLab.listGroups()).find(
      (item) => item.id === target.ownerId,
    );
    if (!owner) throw new Error('克隆对象不存在或已删除。');
    title = owner.name;
    if (target.sessionId === null) {
      messages = persona
        ? sources.agentLab.getConversation(owner.id)
        : sources.agentLab.getGroupMessages(owner.id);
      if (!messages.length) throw new Error('旧版对话不存在或已清空。');
      sessionTitle = '旧版对话';
    } else {
      const session = (
        persona
          ? sources.agentLab.listPersonaSessions(owner.id)
          : sources.agentLab.listGroupSessions(owner.id)
      ).find((item) => item.id === target.sessionId);
      if (!session) throw new Error('克隆会话不存在或已删除。');
      sessionTitle = session.title;
      messages = persona
        ? sources.agentLab.getPersonaSessionConversation(owner.id, session.id)
        : sources.agentLab.getGroupSessionConversation(owner.id, session.id);
    }
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
    target,
    title,
    sessionTitle,
    capturedAt: Date.now(),
    ...(wanted ? { selectedIds: [...wanted] } : {}),
    messages: selected as Array<GeneratedMessage & { id: string }>,
  });
}
