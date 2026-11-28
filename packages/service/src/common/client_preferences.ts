import { menuPreferenceDefaults, menuPreferenceValidators } from './menu_preferences';
export {
  DEFAULT_FORWARD_OPTIONS,
  validForwardOptions,
  type ForwardOptions,
} from './menu_preferences';
import {
  DEFAULT_SEARCH_CATEGORIES,
  SEARCH_SOURCES,
  normalizeSearchPreferences,
  type SearchPreferences,
} from '../account/search_policy';
import { isDirectoryPreference } from './contact_directory_preferences';
import { dataSaverBehaviorDefaults } from './data_saver';
import type { SettingsChange } from './settings_changes';
export {
  accountOrderDefaults,
  FRIEND_SORTS,
  FRIEND_GROUPS,
  GROUP_SORTS,
  GROUP_GROUPS,
  isDirectoryPreference,
  removeBatchCommonFriendCounts,
} from './contact_directory_preferences';
export const MAX_SHARED_DRAFT_IMAGE_BYTES = 32 * 1024 * 1024;
export const CHAT_JUMP_MODES = ['off', 'entry', 'keep'] as const;
export type ChatJumpMode = (typeof CHAT_JUMP_MODES)[number];
export const CHAT_JUMP_MODE_KEYS = [
  'firstUnreadJumpMode',
  'importantJumpMode',
  'readingPositionJumpMode',
  'combinedChatJumpMode',
] as const;

export const preferenceDefaults = {
  ...dataSaverBehaviorDefaults,
  ...menuPreferenceDefaults,
  dataSaverMode: 'auto' as import('./data_saver').DataSaverMode,
  autoDownloadPreviewOriginal: false,
  contactOrder: {} as Record<string, unknown>,
  preference: 'system',
  privacyMode: false,
  capturePrivacy: false,
  webNotifications: false,
  messageNotifications: false,
  applicationBadge: true,
  showMessageUnreadBadge: true,
  showContactNavigationBadge: true,
  showInteractionBadge: false,
  showContactUnreadCount: false,
  showGroupAssistantMessageCount: false,
  showOfficialUnreadBadge: false,
  showServiceUnreadBadge: true,
  showGuildUnreadBadge: true,
  showCloneUnreadBadge: true,
  showAssistantAggregateBadge: true,
  showHiddenUnreadBadge: false,
  showDeletedUnreadBadge: false,
  showConversationPreview: true,
  showImportantMessageMarkers: true,
  showContactRequestBadge: true,
  showTaskRunningBadge: true,
  showTaskResultBadge: true,
  showSoftwareUpdateBadge: true,
  showUpdateBadge: true,
  showOfficialAnnouncementBadge: true,
  accent: '',
  background: 'plain',
  componentStyle: 'qqnt',
  density: 'comfortable',
  specialNumberFont: true,
  mailListWidth: 360,
  showMessageBubble: true,
  showMessageFont: true,
  showAvatarPendant: true,
  showChatQqShow: true,
  showMessageTime: false,
  showMessageDate: false,
  showMessageSeq: false,
  groupConsecutiveMessages: false,
  showUnreadDivider: true,
  showReadingPositionButton: true,
  mergeChatJumpButtons: false,
  firstUnreadJumpMode: 'keep' as ChatJumpMode,
  importantJumpMode: 'keep' as ChatJumpMode,
  readingPositionJumpMode: 'keep' as ChatJumpMode,
  combinedChatJumpMode: 'keep' as ChatJumpMode,
  swipeToQuote: true,
  showGroupMemberName: true,
  showGroupMemberLevel: true,
  showGroupMemberTitle: true,
  autoMentionOnQuote: false,
  backspaceRemovesQuote: true,
  slashEmojiEnabled: true,
  slashEmojiAutoReplace: false,
  keepConversationPositionOnHover: false,
  closeConversationOutsideView: false,
  autoFetchMissingMessages: false,
  autoFetchMissingContext: false,
  missingMessageContextCount: 30,
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
export const AGGREGATE_BADGE_SETTINGS = [
  ['groupAssistant', 'showGroupAssistantMessageCount', 'group-assistant-count', '群助手'],
  ['official', 'showOfficialUnreadBadge', 'official-unread-badge', '公众号'],
  ['service', 'showServiceUnreadBadge', 'service-unread-badge', '服务号'],
  ['guildDirect', 'showGuildUnreadBadge', 'guild-unread-badge', '频道私聊'],
  ['hidden', 'showHiddenUnreadBadge', 'hidden-unread-badge', '已隐藏会话'],
  ['deleted', 'showDeletedUnreadBadge', 'deleted-unread-badge', '已删除会话'],
  ['clone', 'showCloneUnreadBadge', 'clone-unread-badge', '克隆会话'],
  ['assistant', 'showAssistantAggregateBadge', 'assistant-aggregate-badge', 'WeQ 助手会话'],
] as const satisfies readonly (readonly [string, PreferenceKey, string, string])[];
export const CONTACT_UNREAD_COUNT_LABEL = '好友与群聊未读消息数';
export const CONTACT_NAVIGATION_BADGE_SETTING = [
  'showContactNavigationBadge',
  'contact-navigation-badge',
  '联系人导航未读角标',
] as const satisfies readonly [PreferenceKey, string, string];
export const CONTACT_REQUEST_BADGE_SETTING = [
  'showContactRequestBadge',
  'contact-request-badge',
  '好友与群通知未读角标',
] as const satisfies readonly [PreferenceKey, string, string];
export const MENU_BADGE_SETTINGS = [
  ['showTaskRunningBadge', 'task-running-badge', '进行中任务'],
  ['showTaskResultBadge', 'task-result-badge', '已完成任务'],
  ['showSoftwareUpdateBadge', 'software-update-badge', '软件更新'],
  ['showUpdateBadge', 'update-badge', '增强包更新'],
  ['showOfficialAnnouncementBadge', 'official-announcement-badge', '官方公告'],
] as const satisfies readonly (readonly [PreferenceKey, string, string])[];
const retiredUnreadPreferences = new Set([
  'showConversationUnreadBadge',
  'showAssistantUnreadBadge',
  'showMailItemUnreadBadge',
]);
export const displayPreferenceKeys: readonly PreferenceKey[] = [
  'showMessageUnreadBadge',
  'showContactUnreadCount',
  'showGroupAssistantMessageCount',
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
    if (Object.hasOwn(menuPreferenceValidators, key))
      valid = menuPreferenceValidators[key as keyof typeof menuPreferenceValidators](entry);
    else if (key === 'dataSaverMode') valid = ['auto', 'always', 'never'].includes(String(entry));
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
    else if (key === 'missingMessageContextCount')
      valid = typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 500;
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
    else if (CHAT_JUMP_MODE_KEYS.some((mode) => mode === key))
      valid = CHAT_JUMP_MODES.some((mode) => mode === entry);
    else if (Object.hasOwn(preferenceDefaults, key) || retiredUnreadPreferences.has(key))
      valid = typeof entry === 'boolean';
    if (!valid) throw new Error(`无效的共享偏好：${key}`);
  }
}
export function validReadPosition(value: unknown): value is string {
  return typeof value === 'string' && /^(\d{1,20}|-?\d{1,20}:-?\d{1,20}:-?\d{1,20})$/.test(value);
}
export function newerReadPosition(next: string, previous = '0'): boolean {
  const left = next.split(':').map(BigInt);
  const right = previous.split(':').map(BigInt);
  if (left.length !== right.length) return previous === '0';
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}
export const isDirectoryReadKey = (key: string) =>
  /^(persona|clone-group|assistant|official|service|guild):.{1,960}$/.test(key);
export const isQqDirectoryReadKey = (key: string) =>
  /^(?:unread:|initialized:)?(?:official|service|guild)(?::|$)/.test(key);
export const directoryUnreadKey = (key: string) => `unread:${key}`;
export const generatedMuteKey = (id: string) => `mute:${id}`;

export type DirectoryReadChange = {
  key: string;
  before: { position?: string; marker?: string };
  after: { position?: string; marker?: string };
};
/** 与只读分页共用三字段顺序，保留零／重复序号及负消息 ID。 */
export function messageReadPosition(row: {
  msgSeq: string | bigint;
  sendTime: string | bigint;
  msgId: string | bigint;
}): string {
  return `${row.msgSeq}:${row.sendTime}:${row.msgId}`;
}
export function messageReadCursor(position: string) {
  const [msgSeq, sendTime, msgId] = position.includes(':')
    ? position.split(':').map(BigInt)
    : [0n, 0n, -(1n << 63n)];
  return { msgSeq: msgSeq!, sendTime: sendTime!, msgId: msgId! };
}

export function conversationDisplayKey(kind: 'c2c' | 'group', conv: string) {
  return kind === 'group' ? conv : `c2c:${conv}`;
}

export type StateNamespace =
  | 'pins'
  | 'tasks'
  | 'assistant' // 兼容旧客户端及已有快照中的菜单助手已读记录。
  | 'todos'
  | 'order'
  | 'notifications'
  | 'reads'
  | 'conversationDisplay';
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
  section: 'preferences' | StateNamespace | 'drafts' | 'assistantSessions';
  draftKey?: string;
  settings?: SettingsChange;
}
