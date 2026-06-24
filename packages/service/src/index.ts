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
 *   common/     — account-independent helpers that aren't bootstrap services
 *                 (e.g. voice-transcription model management). Zero-native.
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

export { UserConfigService, DEFAULT_APP_SETTINGS } from './bootstrap/user_config';
export type {
  UserConfig,
  InstallCache,
  AutoEnterTarget,
  AppSettings,
  MediaCompletionConfig,
  VoiceTranscribeConfig,
} from './bootstrap/user_config';

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
export { AccountConfigService, accountConfigId, rkeyExpiryMs, clientKeyExpiryMs } from './account/user_config';
export type { AccountConfig, AccountConfigMetadata, DownloadRkey, ClientKey } from './account/user_config';
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
export {
  GroupInfoService,
  type RelationGraphData,
  type RelationGraphNode,
  type RelationGraphGroup,
} from './account/group_info';
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
export { UnreadInfoService } from './account/unread_info';
export { DbDecryptService } from './account/db_decrypt';
export type {
  AccountDbFile,
  DbDecryptItem,
  DbDecryptMode,
  DbDecryptOptions,
  DbDecryptResult,
} from './account/db_decrypt';
export {
  ACCOUNT_HEALTH_DATABASES,
  checkAccountDatabaseHealth,
  formatDbHealthFailures,
} from './account/db_health';
export type { DbHealthFailure } from './account/db_health';

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

// ---- web cgi (query-only: group notice / album list / honor) ----
export { WebQueryService, HonorType, computeBkn } from './account/web';
export type {
  GroupNotice,
  GroupNoticeImage,
  GroupAlbum,
  HonorMember,
  WebCredential,
} from './account/web';

// ---- account protocol services (oidb/trpc packets) ----
export { GroupAlbumMediaService } from './account/group_album_media';
export type {
  AlbumMedia,
  AlbumMediaImage,
  AlbumMediaPage,
  AlbumMediaUrl,
  AlbumPhotoUrl,
} from './account/group_album_media';

export { MediaUrlService, mediaNodeFromElement } from './account/media_url';
export type { MediaElement, GroupFileDownload } from './account/media_url';

// ---- export pipeline (account/export) ----
export {
  exportGroupToJson,
  exportGroupToJsonl,
  exportGroupToTxt,
  iterateGroupMessages,
  toExportedMessage,
  elementsToText,
  messageToText,
  formatTime,
} from './account/export';
export { ExportTaskManager } from './account/export/task_manager';
export type {
  ExportFormat,
  ExportedMessage,
  ExportProgress,
  ProgressCallback as ExportProgressCallback,
  ExportResult,
  GroupExportOptions,
  IterateOptions,
  JsonExportOptions,
  ExportTask,
  TaskStatus,
  TaskProgress,
} from './account/export';

// ---- common (account-independent helpers) ----
export { VoiceTranscribeService, VOICE_MODELS, getVoiceModel } from './common/voice_transcribe';
export type {
  TranscribeModelInfo,
  TranscribeModelFile,
  TranscribeModelStatus,
  DownloadProgress as VoiceDownloadProgress,
} from './common/voice_transcribe';
