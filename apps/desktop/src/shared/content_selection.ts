export type ContentKind =
  | 'conversations'
  | 'conversation-batch'
  | 'messages'
  | 'guild-direct'
  | 'guild-conversations'
  | 'contacts'
  | 'collections'
  | 'mail-messages'
  | 'qzone-posts'
  | 'qzone-albums'
  | 'group-albums'
  | 'group-files'
  | 'emojis'
  | 'market-emojis'
  | 'clone-messages'
  | 'assistant-messages';

export interface ContentOwner {
  conversationTarget?: ConversationBatchTarget;
  kind: ContentKind;
  /** 内容层级的稳定身份，如会话、相册或收藏集合；不能只用内容种类区分。 */
  container: string;
  /** 右键聊天记录专属导出；scope 仍锁定承载该卡片的一条消息。 */
  forwardTarget?: { elementIndex: number; resId: string };
}

export interface GeneratedContentIdentity {
  kind: 'persona' | 'group' | 'assistant';
  ownerId: string;
  sessionId: string | null;
}

export interface ConversationBatchTarget {
  messageIds?: string[];
  forwardTarget?: { elementIndex: number; resId: string };
  /** 统一目录中的行身份，与同批其他来源不能冲突。 */
  id: string;
  name: string;
  kind: 'c2c' | 'group' | 'official' | 'service' | 'guild' | 'persona' | 'cloneGroup' | 'assistant';
  /** 实际数据源键：uid、群号、appId、nodeId 或克隆对象 id。 */
  ownerId?: string;
  sessionId?: string | null;
}

function parseConversationBatchTargets(value: unknown): ConversationBatchTarget[] {
  if (!Array.isArray(value)) throw new Error('批量会话导出目标无效，请重新选择。');
  const targets: ConversationBatchTarget[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('批量会话导出目标无效，请重新选择。');
    const row = raw as Record<string, unknown>;
    const { id, name, kind, ownerId, sessionId } = row;
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !name ||
      (kind !== 'c2c' &&
        kind !== 'group' &&
        kind !== 'official' &&
        kind !== 'service' &&
        kind !== 'guild' &&
        kind !== 'persona' &&
        kind !== 'cloneGroup' &&
        kind !== 'assistant') ||
      (ownerId !== undefined && (typeof ownerId !== 'string' || !ownerId)) ||
      (sessionId !== undefined &&
        sessionId !== null &&
        (typeof sessionId !== 'string' || !sessionId)) ||
      (kind !== 'c2c' && kind !== 'group' && kind !== 'assistant' && !ownerId) ||
      (kind === 'assistant' && (typeof sessionId !== 'string' || !sessionId)) ||
      seen.has(id)
    )
      throw new Error('批量会话导出目标不完整或身份重复，请重新选择。');
    seen.add(id);
    targets.push({
      id,
      name,
      kind,
      ...(typeof ownerId === 'string' ? { ownerId } : {}),
      ...(sessionId !== undefined ? { sessionId: sessionId as string | null } : {}),
    });
  }
  return targets;
}

/** 导出入口冻结来源与身份；后续列表排序、搜索及视图切换不改写本批目标。 */
export function conversationBatchSelection(
  targets: readonly ConversationBatchTarget[],
): ContentSelection {
  const frozen = parseConversationBatchTargets(targets);
  return {
    owner: { kind: 'conversation-batch', container: JSON.stringify(frozen) },
    scope: { type: 'items', ids: frozen.map((target) => target.id) },
  };
}

export function conversationBatchTargets(selection: ContentSelection): ConversationBatchTarget[] {
  if (selection.owner.conversationTarget) {
    if (selection.scope.type !== 'all' && selection.scope.type !== 'items')
      throw new Error('此来源的消息导出选区无效');
    const [target] = parseConversationBatchTargets([selection.owner.conversationTarget]);
    return target
      ? [
          {
            ...target,
            ...(selection.scope.type === 'items'
              ? { messageIds: [...new Set(selection.scope.ids)] }
              : {}),
            ...(selection.owner.forwardTarget
              ? { forwardTarget: { ...selection.owner.forwardTarget } }
              : {}),
          },
        ]
      : [];
  }
  if (selection.owner.kind !== 'conversation-batch') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(selection.owner.container);
  } catch {
    throw new Error('批量会话导出目标读取失败，请重新选择。');
  }
  const targets = parseConversationBatchTargets(raw);
  if (selection.scope.type === 'all') return targets;
  if (selection.scope.type !== 'items') throw new Error('批量会话导出范围无效，请重新选择。');
  const wanted = new Set(selection.scope.ids);
  if ([...wanted].some((id) => !targets.some((target) => target.id === id)))
    throw new Error('部分会话不在本次导出快照中，请重新选择。');
  return targets.filter((target) => wanted.has(target.id));
}

export function generatedContentContainer(target: GeneratedContentIdentity): string {
  return JSON.stringify([target.kind, target.ownerId, target.sessionId]);
}

export function generatedContentIdentity(
  selection?: ContentSelection,
): GeneratedContentIdentity | null {
  if (selection?.owner.kind !== 'clone-messages' && selection?.owner.kind !== 'assistant-messages')
    return null;
  try {
    const value: unknown = JSON.parse(selection.owner.container);
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [kind, ownerId, sessionId] = value;
    if (
      (kind !== 'persona' && kind !== 'group' && kind !== 'assistant') ||
      typeof ownerId !== 'string' ||
      !ownerId ||
      (sessionId !== null && (typeof sessionId !== 'string' || !sessionId))
    )
      return null;
    if (
      (selection.owner.kind === 'assistant-messages') !== (kind === 'assistant') ||
      (kind === 'assistant' && (ownerId !== 'assistant' || sessionId === null))
    )
      return null;
    return { kind, ownerId, sessionId };
  } catch {
    return null;
  }
}

export type ContentFilterValue = string | number | boolean | null;
export type ContentReference =
  | { kind: 'qzone-post'; uin: string; tid: string; name?: string }
  | {
      kind: 'qzone-album' | 'qzone-photo';
      uin: string;
      albumId: string;
      mediaKey?: string;
      name?: string;
    }
  | {
      kind: 'group-album' | 'group-photo';
      groupCode: string;
      albumId: string;
      mediaKey?: string;
      name?: string;
    };

export function contentReferenceKey(item: ContentReference) {
  if (item.kind === 'qzone-post') return JSON.stringify([item.kind, item.uin, item.tid]);
  return JSON.stringify([
    item.kind,
    'uin' in item ? item.uin : item.groupCode,
    item.albumId,
    item.mediaKey ?? '',
  ]);
}
export function groupAlbumReferences(items: ContentReference[]) {
  const groups = new Map<
    string,
    {
      provider: 'qzone' | 'group';
      owner: string;
      albumId: string;
      title?: string;
      mediaKeys?: string[];
    }
  >();
  for (const item of items) {
    if (item.kind === 'qzone-post') continue;
    const provider = 'uin' in item ? ('qzone' as const) : ('group' as const);
    const owner = 'uin' in item ? item.uin : item.groupCode;
    const key = JSON.stringify([provider, owner, item.albumId]);
    const whole = item.kind.endsWith('-album');
    const previous = groups.get(key);
    if (!previous)
      groups.set(key, {
        provider,
        owner,
        albumId: item.albumId,
        ...(whole ? { title: item.name } : { mediaKeys: item.mediaKey ? [item.mediaKey] : [] }),
      });
    else if (whole) {
      delete previous.mediaKeys;
      previous.title = item.name;
    } else if (previous.mediaKeys && item.mediaKey && !previous.mediaKeys.includes(item.mediaKey))
      previous.mediaKeys.push(item.mediaKey);
  }
  return [...groups.values()];
}

export type ContentScope =
  | { type: 'references'; items: ContentReference[] }
  | { type: 'items'; ids: string[] }
  | { type: 'filter'; conditions: Record<string, ContentFilterValue> }
  | { type: 'all' };

export interface ContentSelection {
  owner: ContentOwner;
  scope: ContentScope;
}

export interface ToolDraft {
  accountId: string;
  selection: ContentSelection;
}

export function sameContentOwner(left: ContentOwner, right: ContentOwner): boolean {
  return left.kind === right.kind && left.container === right.container;
}

export function copyContentScope(scope: ContentScope): ContentScope {
  switch (scope.type) {
    case 'references':
      return {
        type: 'references',
        items: [
          ...new Map(scope.items.map((item) => [contentReferenceKey(item), { ...item }])).values(),
        ],
      };
    case 'items':
      return { type: 'items', ids: [...new Set(scope.ids)] };
    case 'filter':
      return { type: 'filter', conditions: { ...scope.conditions } };
    case 'all':
      return { type: 'all' };
  }
}

export function createToolDraft(accountId: string, selection: ContentSelection): ToolDraft {
  return {
    accountId,
    selection: {
      owner: {
        ...selection.owner,
        ...(selection.owner.forwardTarget
          ? { forwardTarget: { ...selection.owner.forwardTarget } }
          : {}),
      },
      scope: copyContentScope(selection.scope),
    },
  };
}

/** 任务拿到独立快照；内容页选择和弹窗草稿都不能改写在途任务。 */
export function freezeToolTarget(accountId: string, draft: ToolDraft): ToolDraft {
  if (draft.accountId !== accountId) throw new Error('不能使用其他账号的工具草稿。');
  return createToolDraft(accountId, draft.selection);
}

export type ContentSelectionAction =
  | { type: 'select'; owner: ContentOwner; ids: readonly string[] }
  | { type: 'toggle'; owner: ContentOwner; id: string }
  | { type: 'clear'; owner: ContentOwner };

export function reduceContentSelection(
  current: ContentSelection | null,
  action: ContentSelectionAction,
): ContentSelection | null {
  if (action.type === 'clear')
    return current && sameContentOwner(current.owner, action.owner) ? null : current;
  if (action.type === 'select')
    return {
      owner: { ...action.owner },
      scope: { type: 'items', ids: [...new Set(action.ids)] },
    };
  const previous =
    current && sameContentOwner(current.owner, action.owner) && current.scope.type === 'items'
      ? current.scope.ids
      : [];
  const ids = new Set(previous);
  if (ids.has(action.id)) ids.delete(action.id);
  else ids.add(action.id);
  return { owner: { ...action.owner }, scope: { type: 'items', ids: [...ids] } };
}
