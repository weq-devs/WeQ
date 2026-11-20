import { searchNameRank, type ConversationScope } from '@weq/service/search-policy';
import type { MainView } from '../../im-template/template/types';
import type { ExportMode } from '../../views/export/types';
import type { DressKind } from '../DressUpDialog';
import type { ContactWorkspaceTab } from '../../lib/profileNavigation';
import {
  findFeature,
  CONVERSATION_CALENDAR_FEATURE,
  CONVERSATION_VIEW_FEATURES,
  QZONE_SECTION_FEATURES,
  OWN_ALBUM_FEATURE,
  type QzoneFeatureSection,
  DRESS_FEATURES,
  EXPORT_FEATURES,
  SETTING_FEATURES,
  SETTINGS_PAGE_FEATURES,
  WORKSPACE_FEATURES,
} from '@weq/service/feature-catalog';
import { isRemoteClient } from '../../lib/remoteClient';
import { settingFeatureAllowed } from '../../../../shared/feature_access';
import { canLinkToFeature } from '../../../../shared/feature_links';
import { APP_NAVIGATION, navigationEntries, type NavigationTool } from '../../lib/appNavigation';
import { CalendarDays, ContactRound, Gift, UsersRound } from 'lucide-react';
import { DRESS_KIND_ICONS, EXPORT_MODE_ICONS, FEATURE_ICONS } from '../../lib/featureIcons.shared';
import type { FeatureIcon } from '../../lib/featureIcons';
import { SETTINGS_PAGE_ICONS } from '../settings/pageIcons.shared';
import { resolveSettingsTarget, type SectionId } from '../settings/navigation';
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
  | { kind: 'conversation-view'; view: keyof typeof CONVERSATION_VIEW_FEATURES }
  | { kind: 'conversation-calendar' }
  | { kind: 'contact-notice'; notice: 'friend' | 'group' }
  | { kind: 'contact-overview' }
  | { kind: 'qzone-section'; section: QzoneFeatureSection }
  | { kind: 'self-qzone-albums' }
  | { kind: 'tool'; tool: SearchableTool; exportMode?: ExportMode }
  | { kind: 'setting'; section: SectionId; item?: string; settingId?: string }
  | { kind: 'composition' }
  | { kind: 'announcements' }
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

function settingEntry(
  definition: (typeof SETTING_FEATURES)[number] | (typeof SETTINGS_PAGE_FEATURES)[number],
): AppSearchEntry {
  const { id, label, aliases, page, path } = definition;
  const target =
    'settingId' in definition
      ? resolveSettingsTarget({ section: page, item: label, settingId: definition.settingId })
      : resolveSettingsTarget({ section: page });
  return {
    id,
    title: label,
    path: path.join(' / '),
    keywords: 'settingId' in definition ? [...aliases, label] : aliases,
    target: { kind: 'setting', ...target },
  };
}

const feature = (
  { id, label, aliases }: { id: string; label: string; aliases: readonly string[] },
  target: AppSearchTarget,
  path = '功能',
): AppSearchEntry => ({
  id,
  title: label,
  path,
  target,
  keywords: aliases,
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
    case 'announcements':
      return APP_NAVIGATION.announcements.icon;
    case 'self-profile':
      return target.tab === 'giftwall' ? Gift : ContactRound;
    case 'clone-create':
      return target.group ? UsersRound : FEATURE_ICONS.clone;
    case 'conversation-directory':
      return target.scope === 'virtual' ? FEATURE_ICONS.clone : FEATURE_ICONS.messages;
    case 'conversation-view':
      return FEATURE_ICONS.messages;
    case 'conversation-calendar':
      return CalendarDays;
    case 'contact-notice':
      return target.notice === 'friend' ? FEATURE_ICONS.friendNotice : FEATURE_ICONS.groupNotice;
    case 'contact-overview':
      return APP_NAVIGATION['group-intersection'].icon;
    case 'qzone-section':
    case 'self-qzone-albums':
      return APP_NAVIGATION.qzone.icon;
    case 'view':
      return (
        Object.values(APP_NAVIGATION).find(
          (entry) => entry.target.kind === 'view' && entry.target.view === target.view,
        )?.icon ?? FEATURE_ICONS.messages
      );
  }
}

const appSearchEntries: readonly AppSearchEntry[] = [
  ...navigationEntries('search', true).map(({ featureId, label, target, keywords }) =>
    feature({ id: featureId, label, aliases: keywords }, target),
  ),
  feature(CONVERSATION_CALENDAR_FEATURE, { kind: 'conversation-calendar' }),
  ...(
    Object.keys(CONVERSATION_VIEW_FEATURES) as Array<keyof typeof CONVERSATION_VIEW_FEATURES>
  ).map((view) => feature(CONVERSATION_VIEW_FEATURES[view], { kind: 'conversation-view', view })),
  feature(WORKSPACE_FEATURES.clones, { kind: 'conversation-directory', scope: 'virtual' }),
  feature(WORKSPACE_FEATURES.createClone, { kind: 'clone-create' }),
  feature(WORKSPACE_FEATURES.createCloneGroup, { kind: 'clone-create', group: true }),
  ...(Object.keys(QZONE_SECTION_FEATURES) as QzoneFeatureSection[]).map((section) =>
    feature(QZONE_SECTION_FEATURES[section], { kind: 'qzone-section', section }),
  ),
  feature(OWN_ALBUM_FEATURE, { kind: 'self-qzone-albums' }),
  ...EXPORT_FEATURES.map((entry) =>
    feature(entry, { kind: 'tool', tool: 'export', exportMode: entry.mode }),
  ),
  feature(WORKSPACE_FEATURES.selfProfile, { kind: 'self-profile' }),
  feature(WORKSPACE_FEATURES.selfProfileEdit, { kind: 'self-profile', tab: 'edit' }),
  feature(
    WORKSPACE_FEATURES.giftWall,
    { kind: 'self-profile', tab: 'giftwall' },
    [WORKSPACE_FEATURES.selfProfile.label, WORKSPACE_FEATURES.giftWall.label].join(' / '),
  ),
  ...DRESS_FEATURES.map((entry) => feature(entry, { kind: 'dressup', dressKind: entry.dressKind })),
  ...SETTINGS_PAGE_FEATURES.map(settingEntry),
  ...SETTING_FEATURES.map(settingEntry),
].filter((entry) => {
  const target = entry.target;
  return (
    import.meta.env.VITE_WEQ_TARGET !== 'web' ||
    target.kind !== 'setting' ||
    settingFeatureAllowed(target, 'web')
  );
});

export function appSearchEntryRank(keyword: string, entry: AppSearchEntry): number {
  return (
    searchNameRank(keyword, entry.title, ...entry.keywords) || searchNameRank(keyword, entry.path)
  );
}

export function searchAppEntries(keyword: string, developmentDressTools = false): AppSearchEntry[] {
  const query = keyword.trim();
  if (!query) return [];
  return appSearchEntries
    .filter((entry) => entry.target.kind !== 'dressup' || developmentDressTools)
    .filter((entry) => {
      if (!isRemoteClient() || entry.target.kind !== 'setting') return true;
      return settingFeatureAllowed(entry.target, 'remote');
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

export function findLinkedAppEntry(featureId: string): AppSearchEntry | undefined {
  const feature = findFeature(featureId);
  if (!feature || !canLinkToFeature(feature)) return undefined;
  const entry = appSearchEntries.find((candidate) => candidate.id === featureId);
  if (
    entry?.target.kind === 'setting' &&
    isRemoteClient() &&
    !settingFeatureAllowed(entry.target, 'remote')
  )
    return undefined;
  return entry;
}

export { appSearchEntries as APP_SEARCH_ENTRIES };
