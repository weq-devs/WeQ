import type { ContentSelection } from '../../../../shared/content_selection';
import type { ExportMode } from './types';

/**
 * 导出面板顶部的「已按当前内容进入」摘要：把选区翻译成一句人话，
 * 让用户不用回头确认自己点的是哪个会话 / 空间 / 收藏。
 */
export function fixedScopeSummary(selection: ContentSelection): string {
  const owner = selection.owner;
  const count = selection.scope.type === 'items' ? selection.scope.ids.length : null;
  switch (owner.kind) {
    case 'messages': {
      const conv = owner.container.slice(owner.container.indexOf(':') + 1);
      return count === null ? `会话 ${conv} · 全部消息` : `会话 ${conv} · 精确选中 ${count} 条消息`;
    }
    case 'conversations': {
      const visible = owner.container === 'recent' || owner.container === 'main-list';
      return count === null
        ? `${visible ? '当前列表' : owner.container} · 全部会话`
        : `已选 ${count} 个会话`;
    }
    case 'guild-direct':
      return count === null ? '频道私聊 · 会话全部消息' : `频道私聊 · 精确选中 ${count} 条消息`;
    case 'guild-conversations':
      return count === null ? '频道私聊 · 全部会话' : `频道私聊 · 已选 ${count} 个会话`;
    case 'contacts':
      return count === null ? '联系人 · 全部' : `联系人 · 精确选中 ${count} 项`;
    case 'collections':
      return count === null ? '收藏 · 全部' : `收藏 · 精确选中 ${count} 条`;
    case 'mail-messages':
      return count === null ? '邮箱 · 所有邮件' : `邮箱 · 已选 ${count} 封邮件`;
    case 'qzone-posts':
      return count === null
        ? `空间 ${owner.container} · 全部说说`
        : `空间 ${owner.container} · ${count} 条说说`;
    case 'qzone-albums':
      return '空间相册';
    case 'group-albums':
      return '群相册';
    case 'group-files':
      return '群文件';
    case 'emojis':
    case 'market-emojis':
      return '表情包';
    case 'clone-messages':
    case 'assistant-messages':
      return count === null ? '克隆与助手对话' : `克隆与助手对话 · ${count} 条`;
  }
}

export function initialExportMode(selection?: ContentSelection): ExportMode {
  switch (selection?.owner.kind) {
    case 'mail-messages':
      return 'mail';
    case 'clone-messages':
    case 'assistant-messages':
      return 'generated';
    case 'guild-direct':
    case 'guild-conversations':
      return 'guild';
    case 'qzone-posts':
      return 'qzone';
    case 'collections':
      return 'collection';
    case 'contacts':
      return 'contacts';
    default:
      return 'full';
  }
}

export function initialQzoneScope(selection?: ContentSelection): { uin?: string; tids?: string[] } {
  if (selection?.owner.kind !== 'qzone-posts') return {};
  return {
    uin: selection.owner.container,
    ...(selection.scope.type === 'items' ? { tids: [...new Set(selection.scope.ids)] } : {}),
  };
}

export function initialGuildScope(selection?: ContentSelection): {
  nodeIds: string[];
  messageIds: Record<string, string[]>;
} {
  if (selection?.owner.kind === 'guild-conversations')
    return {
      nodeIds: selection.scope.type === 'items' ? [...new Set(selection.scope.ids)] : [],
      messageIds: {},
    };
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
  scope: 'friends' | 'group' | 'groups';
  groupListIds?: string[];
  friendUids?: string[];
  groupIds: string[];
  memberUids: Record<string, string[]>;
} {
  if (selection?.owner.kind !== 'contacts')
    return { scope: 'friends', groupIds: [], memberUids: {} };
  const ids = selection.scope.type === 'items' ? [...new Set(selection.scope.ids)] : undefined;
  if (selection.owner.container === 'group-list')
    return { scope: 'groups', groupIds: [], memberUids: {}, ...(ids ? { groupListIds: ids } : {}) };
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
