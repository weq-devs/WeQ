/**
 * `@weq/service` — front-end facing services, split into two layers:
 *
 *   bootstrap/  — usable before any account is selected.
 *                 Take a `Platform` in their constructor.
 *                 (Detect / Key / UserConfig)
 *
 *   account/    — usable after `openAccount()` returned a session.
 *                 Take an `AccountSession` in their constructor.
 *                 (TestMsg, future Profile / Statistics / Report …)
 *
 * Lifecycle: bootstrap services are singletons living for the whole app.
 * Account services are short-lived — recreate on account switch alongside
 * the session.
 */

// ---- bootstrap ----
export { Win32DetectService } from './bootstrap/win32_detect';
export type { QqInstallInfo, DetectedQqProcess } from './bootstrap/win32_detect';

export { Win32KeyService } from './bootstrap/win32_key';
export type {
  KeyResult,
  KeyEvent,
  QuickLoginStreamOptions,
  QrLoginStreamOptions,
} from './bootstrap/win32_key';

export { UserConfigService } from './bootstrap/user_config';
export type { UserConfig, InstallCache, AutoEnterTarget } from './bootstrap/user_config';

export { AvatarCacheService } from './bootstrap/avatar_cache';
export type { AvatarBlob } from './bootstrap/avatar_cache';

export { GlobalConfigService, parseQqVersion } from './bootstrap/global_config';
export type {
  GlobalInstallInfo,
  OnlineProbe,
  DbFileStat,
  DirSize,
} from './bootstrap/global_config';

// ---- account ----
export { AccountConfigService, accountConfigId, rkeyExpiryMs } from './account/user_config';
export type { AccountConfig, AccountConfigMetadata, DownloadRkey } from './account/user_config';
export { AccountMonitorService } from './account/monitor';
export {
  MediaDownloadService,
  PRIVATE_IMAGE_RKEY_TYPE,
  GROUP_IMAGE_RKEY_TYPE,
  PRIVATE_VIDEO_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
} from './account/media_download';
export type { DownloadOptions } from './account/media_download';
export { TestMsgService } from './account/test_msg';
export { RecentContactService } from './account/recent_contact';
export { ForwardMsgService } from './account/forward';
export { MsgService } from './account/msg';
export { GroupInfoService } from './account/group_info';
export { GroupNotifyService } from './account/group_notify';
export { ProfileService } from './account/profile';
export { EmojiService } from './account/emoji';
export { FileAssistantService } from './account/file_assistant';
export { FileSearchService } from './account/file_search';
export type { FileType, SearchResult } from './account/file_search';
export { OnlineStatusService } from './account/online_status';
export type { FormattedOnlineStatus } from './account/online_status';
export type { RenderC2cMsg, RenderGroupMsg } from './account/msg';
export { toRenderElements } from './account/msg_view';
export type { RenderElement, RenderTextElement } from './account/msg_view';
export { MsgSearchService } from './account/msg_search';

// A process-wide singleton (NOT bound to AccountSession): a single polling
// loop you mount/unmount db-watch tasks onto to watch their size for changes.
export { DbWatchService } from './account/db_watch';
export type {
  DbWatchOptions,
  DbChange,
  DbFileSize,
  DbChangeHook,
  DbWatchTask,
  DbWatchHandle,
} from './account/db_watch';

// nt_msg.db watch task: fans every file change into onDbChanged (always) +
// onNewMessages (rowid-delta). Mount the returned task on a DbWatchService.
export { createNtMsgDbHook } from './account/nt_msg_hook';
export type { NewMessages, NtMsgHooks } from './account/nt_msg_hook';
