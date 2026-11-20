import {
  SETTINGS_CATALOG,
  SETTINGS_PAGE_ALIASES,
  SETTINGS_PAGE_LABELS,
  settingsGroupFor,
  type SettingsPageId,
} from '../settings_catalog';
import type { FeatureDefinition } from './model';

export function settingFeatureId(id: string) {
  return `setting:${id}`;
}

function settingsPageFeatureId(page: SettingsPageId) {
  return `settings.page.${page}`;
}

export const SETTINGS_PAGE_FEATURES = (Object.keys(SETTINGS_PAGE_LABELS) as SettingsPageId[]).map(
  (page) =>
    ({
      id: settingsPageFeatureId(page),
      kind: 'setting-page',
      domain: 'settings',
      label: SETTINGS_PAGE_LABELS[page],
      aliases: [page, ...(SETTINGS_PAGE_ALIASES[page] ?? [])],
      settingsPage: page,
      page,
      path: ['设置', settingsGroupFor(page).label, SETTINGS_PAGE_LABELS[page]],
    }) satisfies FeatureDefinition & { page: SettingsPageId; path: string[] },
);

export const SETTING_FEATURES = SETTINGS_CATALOG.map(
  (setting) =>
    ({
      id: settingFeatureId(setting.id),
      kind: 'setting',
      domain: 'settings',
      label: setting.label,
      aliases: setting.aliases,
      parentId: settingsPageFeatureId(setting.section),
      settingId: setting.id,
      settingsPage: setting.section,
      page: setting.section,
      path: setting.path,
      desktopOnly: setting.desktopOnly === true,
      ...(setting.id === 'llm-default-model' ? { operation: 'default-chat-model' as const } : {}),
    }) satisfies FeatureDefinition & {
      settingId: string;
      page: SettingsPageId;
      path: string[];
      desktopOnly: boolean;
    },
);
