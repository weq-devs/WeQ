import {
  BarChart3,
  FileStack,
  FolderOpen,
  Grid2X2,
  Hash,
  House,
  LayoutGrid,
  ListTodo,
  Palette,
  Settings,
} from 'lucide-react';
import { FEATURE_ICONS, type FeatureIcon } from './featureIcons';
import type { MainView } from '../im-template/template/types';

export type NavigationTool = 'export' | 'viewer' | 'analysis' | 'tasks' | 'assistant' | 'backfill';
export type AppNavigationTarget =
  | { kind: 'view'; view: MainView }
  | { kind: 'tool'; tool: NavigationTool }
  | { kind: 'setting'; section: 'startup' }
  | { kind: 'dressup' }
  | { kind: 'composition' }
  | { kind: 'contact-notice'; notice: 'friend' | 'group' };
export type NavigationSurface = 'rail' | 'mobile-tabs' | 'mobile-more' | 'workspace' | 'search';
export interface AppNavigationEntry {
  id: string;
  label: string;
  icon: FeatureIcon;
  target: AppNavigationTarget;
  workspace?: string;
  keywords: readonly string[];
  placements: Partial<Record<NavigationSurface, number>>;
}

// 布局只决定入口的位置；名称、图标、目标和预加载来源在这里统一维护。
export const APP_NAVIGATION = {
  home: {
    label: '主页',
    icon: House,
    target: { kind: 'view', view: 'home' },
    keywords: [],
    placements: { 'mobile-more': 0, search: 0 },
  },
  messages: {
    label: '消息',
    icon: FEATURE_ICONS.messages,
    target: { kind: 'view', view: 'messages' },
    keywords: ['聊天', '会话'],
    placements: { rail: 0, 'mobile-tabs': 0, search: 1 },
  },
  contacts: {
    label: '联系人',
    icon: FEATURE_ICONS.contacts,
    target: { kind: 'view', view: 'contacts' },
    keywords: ['好友', '群聊'],
    placements: { rail: 1, 'mobile-tabs': 1, search: 2 },
  },
  collections: {
    label: '收藏',
    icon: FEATURE_ICONS.collections,
    target: { kind: 'view', view: 'collections' },
    workspace: 'collections',
    keywords: [],
    placements: { rail: 5, 'mobile-more': 4, search: 3 },
  },
  qzone: {
    label: 'QQ 空间',
    icon: FEATURE_ICONS.qzone,
    target: { kind: 'view', view: 'qzone' },
    workspace: 'qzone',
    keywords: ['说说', '相册'],
    placements: { rail: 2, 'mobile-tabs': 2, search: 4 },
  },
  mail: {
    label: 'QQ 邮箱',
    icon: FEATURE_ICONS.mail,
    target: { kind: 'view', view: 'mail' },
    keywords: ['邮件'],
    placements: { rail: 4, 'mobile-more': 1, search: 5 },
  },
  channel: {
    label: 'QQ 频道',
    icon: Hash,
    target: { kind: 'view', view: 'channel' },
    workspace: 'channel',
    keywords: ['频道'],
    placements: { rail: 3, 'mobile-more': 2, search: 6 },
  },
  'guild-direct': {
    label: '频道私聊',
    icon: FEATURE_ICONS.guildDirect,
    target: { kind: 'view', view: 'guild-direct' },
    workspace: 'guild-direct',
    keywords: [],
    placements: { 'mobile-more': 3, search: 7 },
  },
  annual: {
    label: '年度报告',
    icon: FEATURE_ICONS.annual,
    target: { kind: 'view', view: 'annual' },
    workspace: 'annual',
    keywords: ['年度总结'],
    placements: { rail: 6, 'mobile-more': 5, search: 8 },
  },
  dressup: {
    label: '个性装扮',
    icon: Palette,
    target: { kind: 'dressup' },
    workspace: 'dressup',
    keywords: ['装扮商城'],
    placements: { rail: 7, 'mobile-more': 6, search: 9 },
  },
  tasks: {
    label: '任务',
    icon: ListTodo,
    target: { kind: 'tool', tool: 'tasks' },
    keywords: ['导出进度', '下载任务'],
    placements: { 'mobile-more': 7, search: 10 },
  },
  assistant: {
    label: 'WeQ 助手',
    icon: FEATURE_ICONS.assistant,
    target: { kind: 'tool', tool: 'assistant' },
    keywords: ['AI 助手', '智能助手'],
    placements: { 'mobile-more': 8, search: 11 },
  },
  analysis: {
    label: '分析与报告',
    icon: BarChart3,
    target: { kind: 'tool', tool: 'analysis' },
    workspace: 'analysis',
    keywords: ['聊天分析', '统计'],
    placements: { 'mobile-more': 9, workspace: 1, search: 12 },
  },
  export: {
    label: '导出',
    icon: FEATURE_ICONS.export,
    target: { kind: 'tool', tool: 'export' },
    workspace: 'export',
    keywords: ['导出聊天记录', '备份聊天'],
    placements: { 'mobile-more': 10, workspace: 0, search: 13 },
  },
  viewer: {
    label: '导出查看器',
    icon: FolderOpen,
    target: { kind: 'tool', tool: 'viewer' },
    workspace: 'viewer',
    keywords: ['打开导出', 'JSON', 'JSONL'],
    placements: { 'mobile-more': 11, workspace: 2, search: 14 },
  },
  composition: {
    label: '合成聊天记录',
    icon: FileStack,
    target: { kind: 'composition' },
    keywords: ['合并转发'],
    placements: { 'mobile-more': 12, workspace: 3, search: 15 },
  },
  backfill: {
    label: '拉取漫游消息',
    icon: FEATURE_ICONS.backfill,
    target: { kind: 'tool', tool: 'backfill' },
    workspace: 'backfill',
    keywords: ['漫游消息', '补全聊天记录'],
    placements: { search: 16 },
  },
  settings: {
    label: '设置',
    icon: Settings,
    target: { kind: 'setting', section: 'startup' },
    workspace: 'settings',
    keywords: [],
    placements: { rail: 8, 'mobile-more': 13 },
  },
  tools: {
    label: '应用',
    icon: LayoutGrid,
    target: { kind: 'view', view: 'tools' },
    keywords: [],
    placements: { rail: 9 },
  },
  more: {
    label: '更多',
    icon: Grid2X2,
    target: { kind: 'view', view: 'more' },
    keywords: [],
    placements: { 'mobile-tabs': 3 },
  },
  'friend-notice': {
    label: '好友通知',
    icon: FEATURE_ICONS.friendNotice,
    target: { kind: 'contact-notice', notice: 'friend' },
    keywords: [],
    placements: {},
  },
  'group-notice': {
    label: '群通知',
    icon: FEATURE_ICONS.groupNotice,
    target: { kind: 'contact-notice', notice: 'group' },
    keywords: [],
    placements: {},
  },
} satisfies Record<string, Omit<AppNavigationEntry, 'id'>>;

export type AppNavigationId = keyof typeof APP_NAVIGATION;
export function navigationEntries(surface: NavigationSurface): AppNavigationEntry[] {
  return Object.entries(APP_NAVIGATION)
    .map(([id, entry]): AppNavigationEntry => ({ id, ...entry }))
    .filter((entry) => entry.placements[surface] !== undefined)
    .sort((a, b) => a.placements[surface]! - b.placements[surface]!);
}

export interface AppNavigationActions {
  onViewChange: (view: MainView) => void;
  onOpenCollection: () => void;
  onOpenDressUp: () => void;
  onOpenSettings: () => void;
  onOpenTool: (tool: NavigationTool | 'composition') => void;
  onOpenNotice: (notice: 'friend' | 'group') => void;
}

export function activateNavigation(target: AppNavigationTarget, actions: AppNavigationActions) {
  switch (target.kind) {
    case 'view':
      return target.view === 'collections'
        ? actions.onOpenCollection()
        : actions.onViewChange(target.view);
    case 'dressup':
      return actions.onOpenDressUp();
    case 'setting':
      return actions.onOpenSettings();
    case 'tool':
      return actions.onOpenTool(target.tool);
    case 'composition':
      return actions.onOpenTool('composition');
    case 'contact-notice':
      return actions.onOpenNotice(target.notice);
  }
}
