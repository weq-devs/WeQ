export type ContentKind =
  | 'conversations'
  | 'messages'
  | 'guild-direct'
  | 'contacts'
  | 'collections'
  | 'qzone-posts'
  | 'qzone-albums'
  | 'group-albums'
  | 'group-files'
  | 'emojis'
  | 'market-emojis'
  | 'clone-messages'
  | 'assistant-messages';

export interface ContentOwner {
  kind: ContentKind;
  /** 内容层级的稳定身份，如会话、相册或收藏集合；不能只用内容种类区分。 */
  container: string;
}

export interface GeneratedContentIdentity {
  kind: 'persona' | 'group' | 'assistant';
  ownerId: string;
  sessionId: string | null;
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

export type ContentScope =
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
    selection: { owner: { ...selection.owner }, scope: copyContentScope(selection.scope) },
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
