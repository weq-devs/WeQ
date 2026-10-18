import type { ContentSelection } from '../../../../shared/content_selection';
import type { ExportMode } from './types';

export function initialExportMode(selection?: ContentSelection): ExportMode {
  switch (selection?.owner.kind) {
    case 'guild-direct':
      return 'guild';
    case 'collections':
      return 'collection';
    case 'contacts':
      return 'contacts';
    default:
      return 'full';
  }
}

export function initialGuildScope(selection?: ContentSelection): {
  nodeIds: string[];
  messageIds: Record<string, string[]>;
} {
  if (selection?.owner.kind !== 'guild-direct' || !selection.owner.container)
    return { nodeIds: [], messageIds: {} };
  const nodeId = selection.owner.container;
  return {
    nodeIds: [nodeId],
    messageIds:
      selection.scope.type === 'items' ? { [nodeId]: [...new Set(selection.scope.ids)] } : {},
  };
}

export function initialContactScope(selection?: ContentSelection): {
  scope: 'friends' | 'group';
  friendUids?: string[];
  groupIds: string[];
  memberUids: Record<string, string[]>;
} {
  if (selection?.owner.kind !== 'contacts')
    return { scope: 'friends', groupIds: [], memberUids: {} };
  const ids = selection.scope.type === 'items' ? [...new Set(selection.scope.ids)] : undefined;
  if (selection.owner.container === 'groups')
    return { scope: 'group', groupIds: ids ?? [], memberUids: {} };
  if (selection.owner.container.startsWith('group:')) {
    const code = selection.owner.container.slice('group:'.length);
    return {
      scope: 'group',
      groupIds: code ? [code] : [],
      memberUids: code && ids ? { [code]: ids } : {},
    };
  }
  return { scope: 'friends', friendUids: ids, groupIds: [], memberUids: {} };
}

export function initialConversationIds(selection?: ContentSelection): string[] {
  if (selection?.owner.kind === 'conversations' && selection.scope.type === 'items')
    return [...selection.scope.ids].filter((id) => !id.startsWith('virtual:'));
  if (selection?.owner.kind !== 'messages') return [];
  const separator = selection.owner.container.indexOf(':');
  return separator >= 0 ? [selection.owner.container.slice(separator + 1)] : [];
}
