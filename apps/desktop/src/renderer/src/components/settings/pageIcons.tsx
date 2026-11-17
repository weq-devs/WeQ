import { Settings2 } from 'lucide-react';
import type { SettingsPageId } from './navigation';
import { SETTINGS_GROUP_ICONS, SETTINGS_PAGE_ICONS } from './pageIcons.shared';

export function SettingsGroupIcon({ group }: { group: string }) {
  const Icon = SETTINGS_GROUP_ICONS[group] ?? Settings2;
  return <Icon size={16} strokeWidth={1.8} aria-hidden />;
}

export function SettingsPageIcon({ page }: { page: SettingsPageId }) {
  const Icon = SETTINGS_PAGE_ICONS[page];
  return <Icon size={16} strokeWidth={1.8} aria-hidden />;
}
