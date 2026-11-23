import type { AppSettings } from '../../bootstrap/user_config';
import { planSettingsReset } from './reset';
type RequiredSettingKey = {
  [K in keyof AppSettings]-?: Record<string, never> extends Pick<AppSettings, K> ? never : K;
}[keyof AppSettings];

/** 全局恢复与页面恢复共享默认值提供方，新增应用字段必须登记其恢复类别。 */
export const APP_SETTINGS_RESET_POLICY = {
  sharedPreferences: 'shared',
  contactCard: 'preference',
  updateCheckPrerelease: 'preference',
  updateCheckIntervalMinutes: 'preference',
  enhancementUpdates: 'preference',
  toastDurations: 'preference',
  notificationEvents: 'preference',
  exportSaveMode: 'preference',
  realtimeEnabled: 'preference',
  autoAttachQq: 'preference',
  restrictedModeIndicatorEnabled: 'preference',
  restrictedModeBannerEnabled: 'preference',
  webServiceAutoStart: 'connection',
  showWindowOnAutostart: 'connection',
  startupPage: 'preference',
  qqClientSyncEnabled: 'connection',
  qqLiveMessagesEnabled: 'connection',
  qqProxyIndicatorEnabled: 'preference',
  autoLockMinutes: 'preference',
  appLock: 'preference',
  modelResources: 'preference',
  voiceTranscribe: 'preference',
  ocr: 'preference',
  mcp: 'api',
  oneBotByUin: 'api',
  weqAssistant: 'connection',
  agentLab: 'api',
  aiImages: 'preference',
  windowCloseBehavior: 'preference',
  windowsStyleControls: 'preference',
  renderTextMarkdown: 'preference',
  showAvatarPendant: 'preference',
  showChatQqShow: 'preference',
  qqShowCacheMinutes: 'preference',
  linkPreview: 'preference',
  preferCdn: 'preference',
  preferRemoteCdn: 'preference',
  home: 'preference',
  typingStatus: 'preference',
  showMsgDecoration: 'preference',
  showMessageBubble: 'preference',
  showMessageFont: 'preference',
  showMessageSeq: 'preference',
  showMessageDate: 'preference',
  showMessageTime: 'preference',
  showMessageUnreadBadge: 'preference',
  showContactUnreadCount: 'preference',
  readFromFirstUnread: 'preference',
  preserveUnreadUntilRead: 'preference',
  jumpToLatestAfterSend: 'preference',
  autoFollowLatestMessages: 'preference',
  showScrollToBottomButton: 'preference',
  chatImageCacheMiB: 'preference',
  chatMessagePrewarmMiB: 'preference',
  composerFont: 'preference',
  showGroupAssistantMessageCount: 'preference',
  externalChatpic: 'preference',
  externalRkey: 'api',
  ssePush: 'api',
  suppressAttachHint: 'preference',
  suppressDbDamageReminder: 'preference',
  defaultExportDir: 'directory',
  logRetentionDays: 'preference',
  databaseReadConcurrency: 'preference',
  qzonePagination: 'preference',
  qzonePublicRefreshCooldownMinutes: 'preference',
  qzoneForwardQuotePrevious: 'preference',
  qzonePersonClickAction: 'preference',
  qzoneNamePriority: 'preference',
  callRecording: 'preference',
  callDisableP2P: 'preference',
} as const satisfies Record<
  RequiredSettingKey,
  'preference' | 'api' | 'connection' | 'directory' | 'shared'
>;

export const WEQ_DEFAULTS_PATHS = [
  'tencentFilesRootOverride',
  'cacheDirOverride',
  'dbRepairCacheDir',
  'defaultExportDir',
  'externalChatpic',
  'callRecording',
] as const;
export type WeqDefaultsPath = (typeof WEQ_DEFAULTS_PATHS)[number];
export const WEQ_DEFAULTS_CONNECTIONS = [
  'systemAutostart',
  'showWindowOnAutostart',
  'webServiceAutoStart',
  'webEnabled',
  'remoteEnabled',
  'remoteMode',
  'tailscaleEnabled',
  'weqAssistant',
] as const;
export type WeqDefaultsConnection = (typeof WEQ_DEFAULTS_CONNECTIONS)[number];
export interface WeqDefaultsChoice {
  clearApi?: boolean;
  resetPaths?: WeqDefaultsPath[];
  resetConnections?: WeqDefaultsConnection[];
}
export const WEQ_DEFAULTS_PATH_LABELS: Record<WeqDefaultsPath, string> = {
  tencentFilesRootOverride: 'QQ 数据根目录',
  cacheDirOverride: '缓存目录',
  dbRepairCacheDir: '修复临时目录',
  defaultExportDir: '默认导出目录',
  externalChatpic: '外部聊天图片目录',
  callRecording: '通话录音目录',
};

export function settingsDefaults(defaults: AppSettings): AppSettings {
  for (const key of Object.keys(defaults))
    if (!Object.hasOwn(APP_SETTINGS_RESET_POLICY, key)) throw new Error(`设置缺少恢复策略：${key}`);
  return structuredClone(defaults);
}

/** 全局恢复保留项由注册策略筛选，字段变更选择复用页面恢复的规划器。 */
export function globalSettingsDefaults(
  current: Partial<Record<keyof AppSettings, unknown>> | undefined,
  defaults: AppSettings,
  choice: WeqDefaultsChoice,
): AppSettings {
  const result = settingsDefaults(defaults);
  const items = Object.entries(APP_SETTINGS_RESET_POLICY).flatMap(([id, policy]) => {
    const key = id as keyof AppSettings;
    const preserve =
      policy === 'api'
        ? !choice.clearApi
        : policy === 'connection' &&
          !choice.resetConnections?.includes(id as WeqDefaultsConnection);
    if (current?.[key] !== undefined)
      Object.assign(result, { [key]: structuredClone(current[key]) });
    return preserve ? [] : [{ id, current: result[key], defaultValue: defaults[key] }];
  });
  for (const item of planSettingsReset(items))
    Object.assign(result, { [item.id]: structuredClone(item.defaultValue) });
  return result;
}
