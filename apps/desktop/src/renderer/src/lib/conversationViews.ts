import type { Conversation, MergedKind } from '../im-template/template/types';
import { conversationListSearchText } from './conversationListSearchText';
import { conversationRoamingTarget } from './conversationActions';
import { displayGroupName, displayUserName } from '../im-template/template/user';

export const CONVERSATION_VIEWS = [
  'regular',
  'all',
  'groupAssistant',
  'official',
  'service',
  'guild',
  'hidden',
  'deleted',
  'clone',
  'assistant',
] as const;
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];
export const CONVERSATION_VIEW_LABELS: Record<ConversationView, string> = {
  regular: '常规视图',
  all: '全部会话',
  groupAssistant: '群助手',
  official: '公众号',
  service: '服务号',
  guild: '频道私聊',
  hidden: '已隐藏会话',
  deleted: '已删除会话',
  clone: '克隆会话',
  assistant: 'WeQ 助手会话',
};
export const aggregateView = (kind: MergedKind): ConversationView =>
  kind === 'guildDirect' ? 'guild' : kind;

export interface ConversationViewDirectory {
  regular: readonly Conversation[];
  groupAssistant: readonly Conversation[];
  official: readonly Conversation[];
  service: readonly Conversation[];
  guild: readonly Conversation[];
  hidden: readonly Conversation[];
  deleted: readonly Conversation[];
  clone: readonly Conversation[];
  assistant: readonly Conversation[];
}
export interface AllConversationOptions {
  includeHidden: boolean;
  includeDeleted: boolean;
}

export function conversationViewForTarget(
  directory: ConversationViewDirectory | null,
  id: string,
): ConversationView {
  return (
    (
      [
        'hidden',
        'deleted',
        'groupAssistant',
        'official',
        'service',
        'guild',
        'clone',
        'assistant',
      ] as const
    ).find((kind) => directory?.[kind].some((row) => row.id === id)) ?? 'regular'
  );
}

/** 搜索和日历共用同一平铺集合，聚合入口始终只是导航。 */
export function conversationViewRows(
  directory: ConversationViewDirectory,
  view: ConversationView,
  options: AllConversationOptions,
  query = '',
): Conversation[] {
  const rows =
    view === 'all'
      ? [
          ...directory.regular.filter((row) => row.type !== 'merged'),
          ...directory.groupAssistant,
          ...directory.official,
          ...directory.service,
          ...directory.guild,
          ...directory.clone,
          ...directory.assistant,
          ...(options.includeHidden ? directory.hidden : []),
          ...(options.includeDeleted ? directory.deleted : []),
        ]
      : directory[view];
  const excluded = new Set([
    ...(!options.includeHidden && view === 'all' ? directory.hidden.map((row) => row.id) : []),
    ...(!options.includeDeleted && view === 'all' ? directory.deleted.map((row) => row.id) : []),
  ]);
  const needle = query.trim().toLocaleLowerCase();
  const unique = new Map<string, Conversation>();
  for (const row of rows) {
    if (excluded.has(row.id)) continue;
    if (needle && !conversationListSearchText(row).includes(needle)) continue;
    unique.set(row.id, row);
  }
  return [...unique.values()];
}

export type ConversationBatchAction = 'export' | 'roaming' | 'roster' | 'read' | 'delete';
const QQ_ACTIONS: readonly ConversationBatchAction[] = ['export', 'roaming', 'roster', 'read'];
export function conversationViewActions(
  view: ConversationView,
): readonly ConversationBatchAction[] {
  if (view === 'regular' || view === 'groupAssistant') return QQ_ACTIONS;
  if (view === 'hidden' || view === 'deleted') return ['export', 'roaming', 'roster'];
  if (view === 'clone' || view === 'assistant') return ['export', 'delete'];
  if (view === 'all') return [...QQ_ACTIONS, 'delete'];
  return ['export'];
}
export function isGeneratedConversation(row: Conversation): boolean {
  return Boolean(row.generated) || row.id.startsWith('virtual:') || row.id.startsWith('assistant:');
}
export function conversationSupportsAction(
  row: Conversation | undefined,
  action: ConversationBatchAction,
): boolean {
  if (!row || row.type === 'merged') return false;
  const generated = isGeneratedConversation(row);
  if (action === 'delete') return generated;
  if (action === 'export') return true;
  if (generated) return false;
  const special =
    row.directoryKind === 'official' ||
    row.directoryKind === 'service' ||
    row.directoryKind === 'guild' ||
    row.id.startsWith('service:') ||
    row.id.startsWith('guild:');
  if (special) return false;
  if (action === 'read') return !row.hidden && !row.deleted;
  if (action === 'roster') return row.type === 'group' && Boolean(conversationRoamingTarget(row));
  return Boolean(conversationRoamingTarget(row));
}
export function splitConversationAction(
  rows: readonly Conversation[],
  action: ConversationBatchAction,
) {
  return {
    supported: rows.filter((row) => conversationSupportsAction(row, action)),
    unsupported: rows.filter((row) => !conversationSupportsAction(row, action)),
  };
}
export function conversationRowName(row: Conversation): string {
  return row.type === 'merged'
    ? row.title
    : row.type === 'group'
      ? displayGroupName(row.group) || row.id
      : displayUserName(row.otherUser) || row.id;
}
