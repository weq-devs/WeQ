import { searchNameRank, type ConversationScope } from '@weq/service/search-policy';
import type { MainView } from '../../im-template/template/types';
import type { ExportMode } from '../../views/export/types';
import type { DressKind } from '../DressUpDialog';
import type { ContactWorkspaceTab } from '../../lib/profileNavigation';
import { SETTINGS_CATALOG, SETTINGS_PAGE_ALIASES } from '@weq/service/settings-catalog';
import { isRemoteClient } from '../../lib/remoteClient';
import { remoteSettingAvailable } from '../../../../shared/remote_capabilities';
import { APP_NAVIGATION, navigationEntries, type NavigationTool } from '../../lib/appNavigation';
import { ContactRound, Gift, UsersRound } from 'lucide-react';
import {
  DRESS_KIND_ICONS,
  EXPORT_MODE_ICONS,
  FEATURE_ICONS,
  type FeatureIcon,
} from '../../lib/featureIcons';
import { SETTINGS_PAGE_ICONS } from '../settings/pageIcons';
import {
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsGroupFor,
  type SectionId,
} from '../settings/navigation';
export { SETTINGS_PAGE_LABELS } from '../settings/navigation';

export type SearchableTool = NavigationTool;
export interface ToolSearchRequest {
  scope: string;
  tool: SearchableTool;
  exportMode?: ExportMode;
  revision: number;
}
export type AppSearchTarget =
  | { kind: 'view'; view: MainView }
  | { kind: 'conversation-directory'; scope: ConversationScope }
  | { kind: 'tool'; tool: SearchableTool; exportMode?: ExportMode }
  | { kind: 'setting'; section: SectionId; item?: string; settingId?: string }
  | { kind: 'composition' }
  | { kind: 'dressup'; dressKind?: DressKind }
  | { kind: 'self-profile'; tab?: ContactWorkspaceTab }
  | { kind: 'clone-create'; group?: boolean };

export interface AppSearchEntry {
  id: string;
  title: string;
  path: string;
  keywords: readonly string[];
  target: AppSearchTarget;
}

// 这里只保存公开的界面名称与入口，不读取设置值、账号资料或凭据。

function settingEntry(section: SectionId, item?: string, keywords: string[] = []): AppSearchEntry {
  const resolved = resolveSettingsTarget({ section, item });
  const page = SETTINGS_PAGE_LABELS[resolved.section];
  return {
    id: `setting:${resolved.section}:${resolved.settingId ?? item ?? ''}`,
    title: item ? (resolved.item ?? item) : page,
    path: ['设置', settingsGroupFor(resolved.section).label, page].join(' / '),
    keywords: [...keywords, ...(item ? [item] : (SETTINGS_PAGE_ALIASES[resolved.section] ?? []))],
    target: { kind: 'setting', ...resolved },
  };
}

const feature = (
  title: string,
  target: AppSearchTarget,
  ...keywords: string[]
): AppSearchEntry => ({
  id: `feature:${title}`,
  title,
  path: '功能',
  target,
  keywords,
});

export function appSearchIcon(target: AppSearchTarget): FeatureIcon {
  switch (target.kind) {
    case 'setting':
      return SETTINGS_PAGE_ICONS[resolveSettingsTarget(target).section];
    case 'tool':
      return target.tool === 'export' && target.exportMode
        ? EXPORT_MODE_ICONS[target.exportMode]
        : APP_NAVIGATION[target.tool].icon;
    case 'dressup':
      return target.dressKind ? DRESS_KIND_ICONS[target.dressKind] : APP_NAVIGATION.dressup.icon;
    case 'composition':
      return APP_NAVIGATION.composition.icon;
    case 'self-profile':
      return target.tab === 'giftwall' ? Gift : ContactRound;
    case 'clone-create':
      return target.group ? UsersRound : FEATURE_ICONS.clone;
    case 'conversation-directory':
      return target.scope === 'virtual' ? FEATURE_ICONS.clone : FEATURE_ICONS.messages;
    case 'view':
      return (
        Object.values(APP_NAVIGATION).find(
          (entry) => entry.target.kind === 'view' && entry.target.view === target.view,
        )?.icon ?? FEATURE_ICONS.messages
      );
  }
}

function uniqueEntries(entries: AppSearchEntry[]): AppSearchEntry[] {
  const unique = new Map<string, AppSearchEntry>();
  for (const entry of entries) {
    const previous = unique.get(entry.id);
    unique.set(
      entry.id,
      previous ? { ...previous, keywords: [...previous.keywords, ...entry.keywords] } : entry,
    );
  }
  return [...unique.values()];
}

export const APP_SEARCH_ENTRIES: readonly AppSearchEntry[] = uniqueEntries([
  ...navigationEntries('search').flatMap(({ label, target, keywords }) =>
    target.kind === 'contact-notice' ? [] : [feature(label, target, ...keywords)],
  ),
  feature('好友克隆', { kind: 'conversation-directory', scope: 'virtual' }, '克隆聊天'),
  feature('新建好友克隆', { kind: 'clone-create' }, '创建克隆'),
  feature('新建克隆体群聊', { kind: 'clone-create', group: true }, '克隆群聊'),
  ...(
    [
      ['聊天消息导出', 'full', '完整消息导出'],
      ['定时导出', 'scheduled', '定时任务', '自动备份'],
      ['频道私聊数据', 'guild', '导出频道私聊'],
      ['克隆与助手对话', 'generated', '导出克隆对话', '导出助手会话'],
      ['QQ 空间导出', 'qzone', '导出说说'],
      ['导出联系人', 'contacts', '好友名单', '群成员名单', 'vCard'],
      ['导出收藏', 'collection', '收藏导出'],
      ['邮件导出', 'mail', '导出邮件'],
      ['导出表情包', 'emojipack', '表情包导出'],
      ['群相册导出', 'album', '群相册'],
      ['群文件导出', 'groupfile', '群文件'],
      ['明文数据库', 'database', '数据库导出'],
      ['克隆体机器人', 'persona-bot', '克隆机器人导出'],
      ['个人空间相册', 'qzone', '空间相册导出'],
    ] as const
  ).map(([title, exportMode, ...aliases]) =>
    feature(title, { kind: 'tool', tool: 'export', exportMode }, ...aliases),
  ),
  feature('我的资料', { kind: 'self-profile' }, '本人资料', '个人资料'),
  {
    ...feature('礼物墙', { kind: 'self-profile', tab: 'giftwall' }, '我的礼物墙', '礼物'),
    path: '我的资料 / 礼物墙',
  },
  ...(
    [
      ['气泡商城', 'bubble', '聊天气泡', '气泡'],
      ['字体商城', 'font', '个性字体', '字体'],
      ['头像挂件', 'widget', '挂件商城'],
      ['通话背景', 'callbg'],
      ['QQ 聊天背景', 'background', '聊天背景商城'],
      ['商城表情', 'emoji', '表情商城'],
      ['红包封面', 'redpack', '红包皮肤', '红包'],
    ] as const
  ).map(([title, dressKind, ...aliases]) =>
    feature(title, { kind: 'dressup', dressKind }, ...aliases),
  ),
  ...Object.keys(SETTINGS_PAGE_LABELS).map((section) =>
    settingEntry(section as keyof typeof SETTINGS_PAGE_LABELS, undefined, [section]),
  ),
  ...SETTINGS_CATALOG.map((item) =>
    settingEntry(item.section, item.label, [...(item.aliases ?? [])]),
  ),
]).filter((entry) => {
  const target = entry.target;
  return !(
    import.meta.env.VITE_WEQ_TARGET === 'web' &&
    target.kind === 'setting' &&
    SETTINGS_CATALOG.some((item) => item.id === target.settingId && item.desktopOnly)
  );
});

export function appSearchEntryRank(keyword: string, entry: AppSearchEntry): number {
  return (
    searchNameRank(keyword, entry.title, ...entry.keywords) || searchNameRank(keyword, entry.path)
  );
}

export function searchAppEntries(keyword: string): AppSearchEntry[] {
  const query = keyword.trim();
  if (!query) return [];
  return APP_SEARCH_ENTRIES.filter((entry) => {
    if (!isRemoteClient() || entry.target.kind !== 'setting') return true;
    const target = resolveSettingsTarget(entry.target);
    // 页面 / settingId / 行名三种禁项都在 shared/remote_capabilities 里，这里只消费。
    return remoteSettingAvailable(target.section, target.settingId, target.item);
  })
    .map((entry, index) => ({
      entry,
      index,
      rank: appSearchEntryRank(query, entry),
    }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(({ entry }) => entry);
}
