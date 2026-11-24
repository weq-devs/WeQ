import type { SettingsPageId } from './navigation';
import { SETTINGS_PAGE_ICONS } from './pageIcons.shared';

export function SettingsPageIcon({ page }: { page: SettingsPageId }) {
  const Icon = SETTINGS_PAGE_ICONS[page];
  return <Icon size={16} strokeWidth={1.8} aria-hidden />;
}
