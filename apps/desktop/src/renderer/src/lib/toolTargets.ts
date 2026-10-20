/**
 * 浮动工具主按钮「按当前界面直接进入」的目标推导。
 *
 * 这里是纯函数，方便单测：界面上看到了什么（消息页的当前会话、联系人页选中的
 * 好友 / 群、空间页正在看的空间、收藏页……），决定主按钮往哪个工具、带哪份
 * 内容进去。
 *
 * 推导不出目标时**照常返回默认种类**、让面板自己让人选 —— 主按钮任何时候都能点，
 * 只有「导哪一类」和「要不要预选内容」不同。
 */

import { classifyChatType } from '@weq/codec';
import type { Contact, Conversation, GroupConversation } from '../im-template/template/types';
import type { ContentSelection } from '../../../shared/content_selection';
import type { ExportMode } from '../views/export/types';
import type { AnalysisTarget } from '../views/analysis/model';

/** 消息页里当前会话的补充身份（由 MainView 提供）。 */
export interface WorkspaceContext {
  view: string;
  conversation?: Conversation | null;
  /** 正在浏览的具体公众号 / 服务号（ARK Feed）；没有就是合并入口。 */
  officialFeed?: { kind: 'official' | 'service'; conversationId: string; title: string } | null;
  /** 联系人页选中的好友。 */
  contact?: Contact | null;
  /** 联系人页选中的群（群详情）。 */
  groupConversation?: GroupConversation | null;
  /** 空间页正在看的空间 QQ 号（自己或好友）。 */
  spaceUin?: string | null;
  /** AgentLab 里打开的克隆体 / 克隆群。 */
  virtual?: { kind: 'persona' | 'group'; ownerId: string; name: string } | null;
  /** 频道私聊当前打开的节点。 */
  guildNodeId?: string | null;
}

export interface ExportEntry {
  mode: ExportMode;
  selection?: ContentSelection;
  /** 直接进入灯箱（会话 / 精确消息这类「已经选好内容」的入口）。 */
  fixedScope?: boolean;
  label: string;
}

/**
 * 主按钮的导出目标。页面上没有「当前内容」（设置、邮箱、年度报告……）时退回
 * 聊天消息的完整选择界面 —— 主按钮任何时候都能点，选哪份内容交给面板。
 */
export function exportEntryForWorkspace(ctx: WorkspaceContext): ExportEntry {
  const conversation = ctx.conversation;
  if (ctx.view === 'messages' && conversation) {
    const entry = exportEntryForConversation(conversation);
    if (entry) return entry;
    if (conversation.type === 'merged')
      // 聚合入口没有单一会话：仍然进聊天消息面板，由面板里自己挑。
      return { mode: 'full', label: '导出聊天记录' };
  }
  if (ctx.view === 'messages' && ctx.officialFeed) {
    const conv = ctx.officialFeed.conversationId;
    return {
      mode: 'full',
      label: `导出「${ctx.officialFeed.title}」`,
      selection: {
        owner: { kind: 'messages', container: `c2c:${conv}` },
        scope: { type: 'all' },
      },
      fixedScope: true,
    };
  }
  if (ctx.view === 'contacts') {
    // 联系人页进入的永远是联系人导出；当前选中的好友 / 群只改范围，不改种类，
    // 免得「点主按钮导出好友」变成导出群的成员名单。
    return {
      mode: 'contacts',
      label: ctx.contact
        ? `导出联系人（选中 ${ctx.contact.displayName || ctx.contact.identityValue}）`
        : ctx.groupConversation
          ? `导出联系人（群「${ctx.groupConversation.group.name || ctx.groupConversation.group.id}」）`
          : '导出联系人',
      selection: { owner: { kind: 'contacts', container: 'friends' }, scope: { type: 'all' } },
    };
  }
  if (ctx.view === 'qzone') {
    const uin = ctx.spaceUin;
    // 好友的空间在空间页里可能还没解析到 uin：此时仍然进空间导出，只是由面板
    // 让人选目标，而不是把主按钮禁用掉。
    return uin
      ? {
          mode: 'qzone',
          label: '导出当前空间',
          selection: { owner: { kind: 'qzone-posts', container: uin }, scope: { type: 'all' } },
        }
      : { mode: 'qzone', label: '导出空间' };
  }
  if (ctx.view === 'collections')
    return {
      mode: 'collection',
      label: '导出收藏',
      selection: { owner: { kind: 'collections', container: 'all' }, scope: { type: 'all' } },
    };
  if (ctx.view === 'channel' || ctx.view === 'guild-direct') {
    const nodeId = ctx.guildNodeId;
    return nodeId
      ? {
          mode: 'guild',
          label: '导出当前频道私聊',
          selection: { owner: { kind: 'guild-direct', container: nodeId }, scope: { type: 'all' } },
          fixedScope: true,
        }
      : { mode: 'guild', label: '导出频道私聊' };
  }
  if (ctx.view === 'agentlab' && ctx.virtual) {
    const container = JSON.stringify([ctx.virtual.kind, ctx.virtual.ownerId, null] satisfies [
      string,
      string,
      null,
    ]);
    return {
      mode: 'generated',
      label: `导出「${ctx.virtual.name}」`,
      selection: {
        owner: { kind: 'clone-messages', container },
        scope: { type: 'all' },
      },
      fixedScope: true,
    };
  }
  return { mode: 'full', label: '导出聊天记录' };
}

/** 单个真实会话 → 导出入口；克隆体 / 合并入口 / 不支持的会话返回 null。 */
export function exportEntryForConversation(conversation: Conversation): ExportEntry | null {
  if (conversation.id.startsWith('virtual:')) {
    const parts = conversation.id.split(':');
    const kind = parts[1];
    const ownerId = parts.slice(2).join(':');
    if ((kind === 'persona' || kind === 'group') && ownerId)
      return {
        mode: 'generated',
        label: `导出「${conversationTitle(conversation)}」`,
        selection: {
          owner: { kind: 'clone-messages', container: JSON.stringify([kind, ownerId, null]) },
          scope: { type: 'all' },
        },
        fixedScope: true,
      };
    return null;
  }
  if (conversation.type === 'group')
    return {
      mode: 'full',
      label: `导出「${conversation.group.name || conversation.group.id}」`,
      selection: {
        owner: { kind: 'messages', container: `group:${conversation.group.id}` },
        scope: { type: 'all' },
      },
      fixedScope: true,
    };
  if (conversation.type === 'direct') {
    // 私聊 / 临时会话 / 公众号 / 服务号 / 数据线都落在 c2c 导出链路里
    // （数据线没有 uin，用 uid 作会话键；公众号在 c2c_msg_table）。
    return {
      mode: 'full',
      label: `导出「${conversationTitle(conversation)}」`,
      selection: {
        owner: { kind: 'messages', container: `c2c:${conversation.id}` },
        scope: { type: 'all' },
      },
      fixedScope: true,
    };
  }
  return null;
}

export function conversationTitle(conversation: Conversation): string {
  if (conversation.type === 'group') return conversation.group.name || conversation.group.id;
  if (conversation.type === 'direct')
    return conversation.otherUser.displayName || conversation.otherUser.identityValue;
  return conversation.title;
}

/**
 * 主按钮的报告目标：群聊 → 群聊报告，好友私聊 → 好友分析。
 * 克隆体、数据线、公众号、频道、聚合入口都不支持，返回 null 并由 UI 禁用。
 */
export function analysisTargetForWorkspace(ctx: WorkspaceContext): AnalysisTarget | null {
  const conversation = ctx.conversation;
  if (ctx.view === 'messages' && conversation) {
    if (conversation.type === 'group') return { kind: 'group', groupCode: conversation.group.id };
    if (conversation.type === 'direct') {
      const kind =
        conversation.chatType === undefined ? 'direct' : classifyChatType(conversation.chatType);
      // 只认真正的好友私聊：数据线 / 公众号 / 服务号 / 群临时会话没有好友分析口径。
      if ((kind === null || kind === 'direct') && conversation.otherUser.id.startsWith('u_'))
        return { kind: 'buddy', peerUid: conversation.otherUser.id };
    }
    return null;
  }
  if (ctx.view === 'contacts') {
    if (ctx.contact?.id.startsWith('u_')) return { kind: 'buddy', peerUid: ctx.contact.id };
    if (ctx.groupConversation) return { kind: 'group', groupCode: ctx.groupConversation.group.id };
  }
  return null;
}

/**
 * 当前界面「正在看的内容」的稳定选中项。
 *
 * 与 {@link exportEntryForWorkspace} 的区别：这里只返回**由界面位置直接确定的**
 * 那份内容（当前会话 / 空间 / 频道私聊 / 克隆体），不再把设置页之类的兜底算进来。
 * 返回值来自 `exportEntryForWorkspace`，但调用方只在点击时读取，避免把每次渲染
 * 新建的对象塞进 React 依赖。
 */
export function defaultSelectionForContext(ctx: WorkspaceContext): ContentSelection | undefined {
  const entry = exportEntryForWorkspace(ctx);
  return entry.selection;
}

/** 与 {@link defaultSelectionForContext} 配套的导出种类。 */
export function defaultModeForContext(ctx: WorkspaceContext): ExportMode {
  return exportEntryForWorkspace(ctx).mode;
}
