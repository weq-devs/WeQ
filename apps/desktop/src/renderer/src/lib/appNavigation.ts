import { NAVIGATION_FEATURES } from '@weq/service/feature-catalog/navigation';
import {
  BarChart3,
  FileStack,
  FileText,
  FolderOpen,
  Grid2X2,
  Hash,
  House,
  LayoutGrid,
  ListTodo,
  Megaphone,
  Settings,
  Waypoints,
} from 'lucide-react';
import { FEATURE_ICONS } from './featureIcons.shared';
import type { FeatureIcon } from './featureIcons';
import type { MainView } from '../im-template/template/types';

export type NavigationTool =
  | 'export'
  | 'viewer'
  | 'analysis'
  | 'analysis-reports'
  | 'tasks'
  | 'assistant'
  | 'backfill';
export type AppNavigationTarget =
  | { kind: 'view'; view: MainView }
  | { kind: 'tool'; tool: NavigationTool }
  | { kind: 'setting'; section: 'startup' }
  | { kind: 'dressup' }
  | { kind: 'composition' }
  | { kind: 'announcements' }
  | { kind: 'contact-overview' }
  | { kind: 'contact-notice'; notice: 'friend' | 'group' };
export type NavigationSurface = 'rail' | 'mobile-tabs' | 'mobile-more' | 'workspace' | 'search';
export interface AppNavigationEntry {
  id: string;
  featureId: string;
  label: string;
  icon: FeatureIcon;
  target: AppNavigationTarget;
  workspace?: string;
  keywords: readonly string[];
  placements: Partial<Record<NavigationSurface, number>>;
}

function navigationMetadata(key: keyof typeof NAVIGATION_FEATURES) {
  const { id, label, aliases } = NAVIGATION_FEATURES[key];
  return { featureId: id, label, keywords: aliases };
}

// 共用目录提供名称与检索信息，客户端在这里维护目标、图标和版位。
export const APP_NAVIGATION = {
  announcements: {
    ...navigationMetadata('announcements'),
    icon: Megaphone,
    target: { kind: 'announcements' },
    placements: { 'mobile-more': -1, search: 18 },
  },
  home: {
    ...navigationMetadata('home'),
    icon: House,
    target: { kind: 'view', view: 'home' },
    placements: { 'mobile-more': 0, search: 0 },
  },
  messages: {
    ...navigationMetadata('messages'),
    icon: FEATURE_ICONS.messages,
    target: { kind: 'view', view: 'messages' },
    placements: { rail: 0, 'mobile-tabs': 0, search: 1 },
  },
  contacts: {
    ...navigationMetadata('contacts'),
    icon: FEATURE_ICONS.contacts,
    target: { kind: 'view', view: 'contacts' },
    placements: { rail: 1, 'mobile-tabs': 1, search: 2 },
  },
  collections: {
    ...navigationMetadata('collections'),
    icon: FEATURE_ICONS.collections,
    target: { kind: 'view', view: 'collections' },
    workspace: 'collections',
    placements: { rail: 5, 'mobile-more': 4, search: 3 },
  },
  qzone: {
    ...navigationMetadata('qzone'),
    icon: FEATURE_ICONS.qzone,
    target: { kind: 'view', view: 'qzone' },
    workspace: 'qzone',
    placements: { rail: 2, 'mobile-tabs': 2, search: 4 },
  },
  mail: {
    ...navigationMetadata('mail'),
    icon: FEATURE_ICONS.mail,
    target: { kind: 'view', view: 'mail' },
    placements: { rail: 4, 'mobile-more': 1, search: 5 },
  },
  channel: {
    ...navigationMetadata('channel'),
    icon: Hash,
    target: { kind: 'view', view: 'channel' },
    workspace: 'channel',
    placements: { rail: 3, search: 6 },
  },
  'guild-direct': {
    ...navigationMetadata('guild-direct'),
    icon: FEATURE_ICONS.guildDirect,
    target: { kind: 'view', view: 'guild-direct' },
    workspace: 'guild-direct',
    placements: { search: 7 },
  },
  annual: {
    ...navigationMetadata('annual'),
    icon: FEATURE_ICONS.annual,
    target: { kind: 'view', view: 'annual' },
    workspace: 'annual',
    placements: { rail: 6, 'mobile-more': 5, search: 8 },
  },
  dressup: {
    ...navigationMetadata('dressup'),
    icon: FEATURE_ICONS.dressup,
    target: { kind: 'dressup' },
    workspace: 'dressup',
    placements: { rail: 7, 'mobile-more': 6, search: 9 },
  },
  tasks: {
    ...navigationMetadata('tasks'),
    icon: ListTodo,
    target: { kind: 'tool', tool: 'tasks' },
    placements: { 'mobile-more': 7, search: 10 },
  },
  assistant: {
    ...navigationMetadata('assistant'),
    icon: FEATURE_ICONS.assistant,
    target: { kind: 'tool', tool: 'assistant' },
    placements: { search: 11 },
  },
  analysis: {
    ...navigationMetadata('analysis'),
    icon: BarChart3,
    target: { kind: 'tool', tool: 'analysis' },
    workspace: 'analysis',
    placements: { 'mobile-more': 9, workspace: 0, search: 12 },
  },
  'analysis-reports': {
    ...navigationMetadata('analysis-reports'),
    icon: FileText,
    target: { kind: 'tool', tool: 'analysis-reports' },
    workspace: 'analysis-reports',
    placements: { 'mobile-more': 10, workspace: 1, search: 13 },
  },
  export: {
    ...navigationMetadata('export'),
    icon: FEATURE_ICONS.export,
    target: { kind: 'tool', tool: 'export' },
    workspace: 'export',
    placements: { 'mobile-more': 11, workspace: 2, search: 14 },
  },
  viewer: {
    ...navigationMetadata('viewer'),
    icon: FolderOpen,
    target: { kind: 'tool', tool: 'viewer' },
    workspace: 'viewer',
    placements: { 'mobile-more': 12, workspace: 3, search: 15 },
  },
  composition: {
    ...navigationMetadata('composition'),
    icon: FileStack,
    target: { kind: 'composition' },
    placements: { 'mobile-more': 13, workspace: 4, search: 16 },
  },
  backfill: {
    ...navigationMetadata('backfill'),
    icon: FEATURE_ICONS.backfill,
    target: { kind: 'tool', tool: 'backfill' },
    workspace: 'backfill',
    placements: { search: 17 },
  },
  settings: {
    ...navigationMetadata('settings'),
    icon: Settings,
    target: { kind: 'setting', section: 'startup' },
    workspace: 'settings',
    placements: { rail: 8, 'mobile-more': 14 },
  },
  tools: {
    ...navigationMetadata('tools'),
    icon: LayoutGrid,
    target: { kind: 'view', view: 'tools' },
    placements: { rail: 9 },
  },
  more: {
    ...navigationMetadata('more'),
    icon: Grid2X2,
    target: { kind: 'view', view: 'more' },
    placements: { 'mobile-tabs': 3 },
  },
  'friend-notice': {
    ...navigationMetadata('friend-notice'),
    icon: FEATURE_ICONS.friendNotice,
    target: { kind: 'contact-notice', notice: 'friend' },
    placements: {},
  },
  'group-notice': {
    ...navigationMetadata('group-notice'),
    icon: FEATURE_ICONS.groupNotice,
    target: { kind: 'contact-notice', notice: 'group' },
    placements: {},
  },
  'group-intersection': {
    ...navigationMetadata('group-intersection'),
    icon: Waypoints,
    target: { kind: 'contact-overview' },
    placements: {},
  },
} satisfies Record<string, Omit<AppNavigationEntry, 'id'>>;

export type AppNavigationId = keyof typeof APP_NAVIGATION;
export function navigationEntries(
  surface: NavigationSurface,
  developmentDressTools = false,
): AppNavigationEntry[] {
  return Object.entries(APP_NAVIGATION)
    .map(([id, entry]): AppNavigationEntry => ({ id, ...entry }))
    .filter((entry) => entry.placements[surface] !== undefined)
    .filter((entry) => entry.target.kind !== 'dressup' || developmentDressTools)
    .sort((a, b) => a.placements[surface]! - b.placements[surface]!);
}

export interface AppNavigationActions {
  onViewChange: (view: MainView) => void;
  onOpenCollection: () => void;
  onOpenDressUp: () => void;
  onOpenSettings: () => void;
  onOpenTool: (tool: NavigationTool | 'composition') => void;
  onOpenNotice: (notice: 'friend' | 'group') => void;
  onOpenContactOverview?: () => void;
  onOpenAnnouncements?: () => void;
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
    case 'announcements':
      return actions.onOpenAnnouncements?.();
    case 'contact-notice':
      return actions.onOpenNotice(target.notice);
    case 'contact-overview':
      return actions.onOpenContactOverview?.();
  }
}
