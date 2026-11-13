import {
  DEFAULT_SEARCH_CATEGORIES,
  SEARCH_SOURCES,
  normalizeSearchPreferences,
  type SearchPreferences,
} from '../account/search_policy';
import { isDirectoryPreference } from './contact_directory_preferences';
import { dataSaverBehaviorDefaults } from './data_saver';
export {
  accountOrderDefaults,
  FRIEND_SORTS,
  FRIEND_GROUPS,
  GROUP_SORTS,
  GROUP_GROUPS,
  isDirectoryPreference,
} from './contact_directory_preferences';
export const MAX_SHARED_DRAFT_IMAGE_BYTES = 32 * 1024 * 1024;

export const preferenceDefaults = {
  ...dataSaverBehaviorDefaults,
  dataSaverMode: 'auto' as import('./data_saver').DataSaverMode,
  contactOrder: {} as Record<string, unknown>,
  preference: 'system',
  privacyMode: false,
  capturePrivacy: false,
  webNotifications: false,
  messageNotifications: false,
  applicationBadge: true,
  accent: '',
  background: 'plain',
  componentStyle: 'qqnt',
  density: 'comfortable',
  mailListWidth: 360,
  showMessageBubble: true,
  showMessageFont: true,
  showAvatarPendant: true,
  showChatQqShow: true,
  showMessageTime: false,
  showMessageDate: false,
  showMessageSeq: false,
  keepConversationPositionOnHover: false,
  allConversationsIncludeHidden: false,
  allConversationsIncludeDeleted: false,
  search: normalizeSearchPreferences(null) as SearchPreferences,
  calendar: [
    'c2c',
    'group',
    'dataline',
    'official',
    'service',
    'guild',
    'persona',
    'cloneGroup',
    'assistant',
  ],
};
export type PreferenceKey = keyof typeof preferenceDefaults;
export type PreferenceValues = typeof preferenceDefaults;
export type PreferencePatch = Partial<PreferenceValues>;
export const displayPreferenceKeys: readonly PreferenceKey[] = [
  'accent',
  'background',
  'componentStyle',
  'density',
  'showMessageBubble',
  'showMessageFont',
  'showAvatarPendant',
  'showChatQqShow',
  'showMessageTime',
  'showMessageDate',
  'showMessageSeq',
];
export const legacyPreferenceKeys: Partial<Record<PreferenceKey, string>> = {
  preference: 'weq.theme-preference',
  privacyMode: 'weq.privacy-mode',
  capturePrivacy: 'weq.privacy-menu-capture',
  webNotifications: 'weq:web-notifications',
  accent: 'weq.theme-accent',
  background: 'weq.theme-background',
  componentStyle: 'weq.theme-component-style',
  density: 'weq.theme-density',
  search: 'weq.global-search.preferences',
  calendar: 'weq.calendar.kinds',
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validatePreferencePatch(value: unknown): asserts value is PreferencePatch {
  if (!isRecord(value)) throw new Error('偏好必须是对象');
  for (const [key, entry] of Object.entries(value)) {
    let valid = false;
    if (key === 'dataSaverMode') valid = ['auto', 'always', 'never'].includes(String(entry));
    else if (key === 'dataSaverImageLoading')
      valid = ['none', 'thumbnail', 'original'].includes(String(entry));
    else if (key === 'dataSaverLargeMiB')
      valid =
        typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 1048576;
    else if (key === 'preference') valid = ['system', 'light', 'dark'].includes(String(entry));
    else if (key === 'accent')
      valid = typeof entry === 'string' && (entry === '' || /^#[\da-f]{6}$/i.test(entry));
    else if (key === 'background')
      valid = ['plain', 'paper', 'grid', 'dots', 'wash', 'telegram'].includes(String(entry));
    else if (key === 'componentStyle')
      valid = ['qqnt', 'classic', 'minimal', 'retro'].includes(String(entry));
    else if (key === 'density') valid = entry === 'comfortable' || entry === 'compact';
    else if (key === 'mailListWidth')
      valid = typeof entry === 'number' && Number.isFinite(entry) && entry >= 280 && entry <= 560;
    else if (key === 'contactOrder')
      valid =
        isRecord(entry) &&
        Object.keys(entry).every((part) => ['friends', 'groups', 'refreshRange'].includes(part)) &&
        Object.entries(entry).every(([part, value]) =>
          part === 'refreshRange'
            ? ['older24h', 'all', 'none'].includes(String(value))
            : (part === 'friends' || part === 'groups') &&
              isDirectoryPreference(part, value) &&
              Object.keys(value).every((field) =>
                ['grouping', 'sort', 'descending'].includes(field),
              ),
        );
    else if (key === 'calendar')
      valid =
        Array.isArray(entry) && entry.every((part) => preferenceDefaults.calendar.includes(part));
    else if (key === 'search')
      valid =
        isRecord(entry) &&
        Object.keys(entry).every((part) =>
          ['version', 'sources', 'categories', 'appEnabled', 'numberLookupEnabled'].includes(part),
        ) &&
        Array.isArray(entry.categories) &&
        entry.categories.every(
          (part) =>
            DEFAULT_SEARCH_CATEGORIES.includes(part) ||
            (entry.version === undefined && ['groupAlbum', 'assistantMessage'].includes(part)),
        ) &&
        (entry.version === undefined || entry.version === 2) &&
        (entry.version === undefined ||
          (Array.isArray(entry.sources) &&
            entry.sources.every((part) => SEARCH_SOURCES.includes(part)))) &&
        typeof entry.appEnabled === 'boolean' &&
        typeof entry.numberLookupEnabled === 'boolean';
    else if (Object.hasOwn(preferenceDefaults, key)) valid = typeof entry === 'boolean';
    if (!valid) throw new Error(`无效的共享偏好：${key}`);
  }
}
export type StateNamespace = 'pins' | 'tasks' | 'assistant' | 'todos' | 'order';
export type StateRecords = Partial<Record<StateNamespace, Record<string, unknown>>>;
export interface SharedDraft {
  version: string | null;
  value: unknown;
}
export interface ClientStateSnapshot {
  settingsRevision?: number;
  epoch?: string;
  revision: number;
  values: PreferencePatch;
  records: StateRecords;
}
export interface ClientStateChange {
  revision: number;
  section: 'preferences' | StateNamespace | 'drafts';
}
