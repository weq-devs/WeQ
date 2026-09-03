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

export { createDirectInjectHook } from './bootstrap/inject';
export type { InjectHook, PtraceHintChoice, PtraceHintAnswer } from './bootstrap/inject';

export { UserConfigService, DEFAULT_APP_SETTINGS } from './bootstrap/user_config';
export type {
  UserConfig,
  AutoEnterTarget,
  InjectRecord,
  AppSettings,
  AppLockConfig,
  AppLockMethod,
  WindowCloseBehavior,
  VoiceTranscribeConfig,
  McpServerConfig,
  WeqAssistantConfig,
  AgentLabSettings,
  LinkPreviewConfig,
  ExternalChatpicConfig,
  ExternalRkeyConfig,
  ExternalRkeyServerConfig,
  SsePushConfig,
  SsePushServerConfig,
  ExportPresets,
  ExportPresetVariant,
  ExportLightboxPreset,
  ExportScheduledPreset,
  ExportPresetOptions,
} from './bootstrap/user_config';
export { AgentLabConfigService } from './bootstrap/agentlab_config';

export { MediaCacheService } from './bootstrap/media_cache';
export type {
  AvatarCacheService,
  AvatarBlob,
  MediaBlob,
  CacheSubdir,
} from './bootstrap/media_cache';

export { LinkPreviewService } from './bootstrap/link_preview';
export type { LinkPreview, ScreenshotHook } from './bootstrap/link_preview';

export { GlobalConfigService } from './bootstrap/global_config';
export type {
  GlobalInstallInfo,
  OnlineProbe,
  DbFileStat,
  DirSize,
  DirSizeProgress,
} from './bootstrap/global_config';

// ---- account ----
export {
  AccountConfigService,
  accountConfigId,
  rkeyExpiryMs,
  clientKeyExpiryMs,
} from './account/user_config';
export {
  chatpicFileName,
  chatpicRelPaths,
  resolveChatpicFile,
  validateChatpicRoot,
  CHATPIC_FOLDERS,
  type ChatpicFolder,
} from './account/chatpic';
export type {
  AccountConfig,
  AccountConfigMetadata,
  DownloadRkey,
  ClientKey,
} from './account/user_config';
export { fetchHomeDress, toPeerDress } from './account/home_dress';
export type { HomeDressSnapshot, PeerDressSnapshot } from './account/home_dress';
export {
  resolveBubbleSkin,
  legacyBubbleStaticUrl,
} from './account/bubble_skin';
export type { BubbleSkin, BubbleSlice, BubbleSource } from './account/bubble_skin';
export { DressService, createDressService } from './account/dress_service';
export { DressConfigService } from './account/dress_config';
export { DressSharedCache, fontFamilyFor } from './account/dress_shared_cache';
export { migrateDressData } from './account/dress_migrate';
export type {
  DressManifest,
  InstalledFont,
} from './account/dress_service';
export type { DressScope, DressBackgroundSource } from './account/dress_config';
export type { BubbleSidecar, PendantSidecar } from './account/dress_shared_cache';
export { MsgDecorationCacheService } from './account/msg_decoration';
export type { ResolvedMsgDecoration, ResolvedWidget } from './account/msg_decoration';
export {
  getDressRank,
  searchDress,
  normalizeMallItems,
  DressAppId,
} from './account/web/dress_mall';
export type { DressMallItem, BubbleMaterial } from './account/web/dress_mall';
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
export type { DownloadOptions, ExternalRkeySource } from './account/media_download';
export { ExternalRkeyService } from './account/external_rkey';
export { normalizeNapcatBaseUrl, fetchNapcatRkeys } from './account/rkey_server';
export type { NapcatRkeyServerResult } from './account/rkey_server';
export { RecentContactService } from './account/recent_contact';
export { GuildDirectService, guildAvatarUrlFromMeta } from './account/guild_direct';
export type { GuildDirectSessionView, RenderGuildDirectMsg } from './account/guild_direct';
export { HiddenSessionService } from './account/hidden_session';
export type { HiddenSessionSummary } from './account/hidden_session';
export { DeletedSessionService } from './account/deleted_session';
export type { DeletedSessionSummary } from './account/deleted_session';
export { OfficialAccountService } from './account/official_account';
export type { OfficialAccountSummary } from './account/official_account';
export { ServiceAccountService } from './account/service_account';
export type { ServiceAccountSummary } from './account/service_account';
export { ForwardMsgService } from './account/forward';
export { MsgService } from './account/msg';
export {
  GroupInfoService,
  type RelationGraphData,
  type RelationGraphNode,
  type RelationGraphGroup,
  type SelfGroupLevel,
  type GroupStatsReport,
  type GroupMessageRankingItem,
  type GroupWordCloudItem,
  type GroupDailyActivityItem,
} from './account/group_info';
export {
  BuddyAnalyticsService,
  type BuddyAnalytics,
  type BuddyReplyStats,
} from './account/buddy_analytics';
export { GroupNotifyService } from './account/group_notify';
export { ProfileService } from './account/profile';
export {
  EmojiService,
  feeTypeLabel as marketFeeTypeLabel,
  type SystemFaceEntry,
  type MarketPackDetail,
  type MarketPackItem,
  type MarketPackKey,
  type MarketPackFeeType,
} from './account/emoji';
export type { MarketEmoticonPackage } from '@weq/db';
export { FileAssistantService } from './account/file_assistant';
export { CollectionService, type CollectionPage } from './account/collection';
export { FileSearchService } from './account/file_search';
export type { FileType, SearchResult } from './account/file_search';
export { OnlineStatusService } from './account/online_status';
export type { FormattedOnlineStatus } from './account/online_status';
export { AgentLabService } from './account/agentlab';
export type {
  AgentLabMediaDeps,
  EndpointResolver,
  AgentLabBuildProgress,
} from './account/agentlab';
export { TokenUsageStore } from './account/agentlab_usage';
export type { TokenStats, TokenUsageRecord } from './account/agentlab_usage';
export { ConversationStore } from './account/agentlab_conversation';
export type { ConversationTurn } from './account/agentlab_conversation';
export {
  WeqAssistantService,
  buildArkJson,
  rewriteArkPort,
  generateWeqAssistantUid,
  WEQ_ASSISTANT_UIN,
  WEQ_ASSISTANT_NICK,
} from './account/weq_assistant';
export type { WeqTweetCard } from './account/weq_assistant';
export { AssistantService, ASSISTANT_AGENT_ID } from './account/assistant';
export type {
  AssistantConfig,
  AssistantReasoningEffort,
  AssistantSession,
  AssistantTools,
  AssistantToolSpec,
  AssistantStep,
  AssistantArtifact,
} from './account/assistant';
export type { RenderC2cMsg, RenderGroupMsg } from './account/msg';
export { DeletedMsgStore } from './account/deleted_msgs';
export type { DeletedMsgRecord } from './account/deleted_msgs';
export { AntiRecallService } from './account/anti_recall';
export type { AntiRecallConfig, AntiRecallStatus } from './account/anti_recall';
export { toRenderElements } from './account/msg_view';
export type { RenderElement, RenderTextElement } from './account/msg_view';
// 渲染层要按这个类型读 RenderTextElement.urlVerify，从 codec 借道转出去。
export type { UrlVerifyInfo } from '@weq/codec';
export { MsgSearchService } from './account/msg_search';
export { UnifiedSearchService } from './account/unified_search';
export type {
  SearchCategory,
  FtsSource,
  ConversationSearchHit,
  FriendSearchHit,
  GroupMemberSearchHit,
  ChatRecordSearchHit,
  FileSearchHit,
  ConversationRecordHit,
  QuickSearchResult,
  SlowSearchResult,
  MoreSearchResult,
} from './account/unified_search';
export { UnreadInfoService } from './account/unread_info';
export { DbDecryptService, isLoginDb, LOGIN_DB_KEY } from './account/db_decrypt';
export type {
  AccountDbFile,
  DbDecryptItem,
  DbDecryptMode,
  DbDecryptOptions,
  DbDecryptResult,
} from './account/db_decrypt';
export { DbExplorerService } from './account/db_explorer';
export type {
  DbCell,
  DbInputValue,
  RowKey,
  DbObject,
  DbColumn,
  TableRowsResult,
  QueryResult,
} from './account/db_explorer';
export { AvatarResourceService, AVATAR_SCOPES, avatarHashForUid } from './account/avatar_resource';
export type {
  AvatarScope,
  AvatarVariant,
  AvatarScopeInfo,
  AvatarEntry,
  AvatarPage,
  AvatarPathProbe,
} from './account/avatar_resource';
export { SysEmojiResourceService } from './account/sys_emoji_resource';
export type {
  SysEmojiFormat,
  SysEmojiEntry,
  SysEmojiPage,
} from './account/sys_emoji_resource';
export { SysEmojiDownloadService } from './account/sys_emoji_download';
export type {
  SysEmojiSource,
  SysEmojiDownloadResult,
  SysEmojiDownloadStatus,
  SysEmojiFetchOutcome,
} from './account/sys_emoji_download';
export { MarketEmojiResourceService } from './account/market_emoji_resource';
export type {
  MarketFaceEntry,
  MarketFacePage,
} from './account/market_emoji_resource';
export {
  CustomEmojiResourceService,
  CUSTOM_EMOJI_SCOPES,
} from './account/custom_emoji_resource';
export type {
  CustomEmojiScope,
  CustomEmojiVariant,
  CustomEmojiScopeInfo,
  CustomEmojiEntry,
  CustomEmojiPage,
} from './account/custom_emoji_resource';
export { RelatedEmojiResourceService } from './account/related_emoji_resource';
export type {
  RelatedEmojiKeyword,
  RelatedEmojiPage,
} from './account/related_emoji_resource';
export { FileResourceService, FILE_CATEGORIES, classifyFile } from './account/file_resource';
export type {
  FileCategory,
  FileSortKey,
  FileSortOrder,
  FileResourceEntry,
  FileDirSummary,
  FileDirPage,
  DownloadFileEntry,
  DownloadFilePage,
  FileListOptions,
} from './account/file_resource';
export { MediaResourceService } from './account/media_resource';
export type {
  MediaResourceKind,
  FlatMediaEntry,
  MonthMediaEntry,
  FlatMediaPage,
  MonthMediaPage,
  VoiceMediaEntry,
  VoiceMediaPage,
  ResourceTreeKey,
  ResourceBucket,
  ResourceStat,
} from './account/media_resource';
export { ResourceCleanupService } from './account/resource_cleanup';
export type {
  CleanupVariant,
  CleanupTier,
  CleanupBucket,
  CleanupTargetStat,
  CleanupInstruction,
  CleanupTargetResult,
  CleanupResult,
} from './account/resource_cleanup';
export {
  ACCOUNT_HEALTH_DATABASES,
  DB_HEALTH_REPORT_PREFIX,
  checkAccountDatabaseHealth,
  collectDbDamageFeedback,
  findLatestDbHealthReport,
  formatDbHealthFailures,
  renderDbHealthReportMarkdown,
  writeDbHealthReport,
} from './account/db_health';
export type {
  DbHealthFailure,
  DbHealthReportInput,
  DbDamageFeedbackInput,
  DbDamageFeedbackResult,
  DbDamageFeedbackTarget,
} from './account/db_health';

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

// SSE 消息推送：监听 nt_msg.db（同 db_watch_listen 的实现路径），防抖 + seq 跳变
// 阈值合并后把事件 POST 到用户配置的推送地址。
export {
  SsePushService,
  normalizeSsePushUrl,
  postSsePushEvents,
  testSsePushTarget,
} from './account/sse_push';
export type {
  SsePushTarget,
  SsePushOptions,
  SsePushEvent,
  SseMessageEvent,
  SseMassEvent,
  SsePushPayload,
} from './account/sse_push';

// ---- web cgi (query-only: group notice / album list / honor) ----
export {
  WebQueryService,
  HonorType,
  computeBkn,
  PT_LOGIN_DOMAINS,
  fetchWebTokens,
  fetchSkeyViaPtLogin,
  fetchPskeyViaPtLogin,
} from './account/web';
export { buildPtlogin2JumpUrl, parseClientKeyJson } from './account/web/ptlogin';
export type {
  GroupNotice,
  GroupNoticeImage,
  GroupAlbum,
  HonorMember,
  WebCredential,
  FriendMutualMark,
  FriendMarkCategory,
  FriendMark,
  FriendMarkLevel,
} from './account/web';

// ---- account protocol services (oidb/trpc packets) ----
export { GapHistoryService } from './account/gap_history';
export type { GapFetchedMessage, GapFetchResult } from './account/gap_history';
export { GroupFileService } from './account/group_file';
export type { GroupFileItem, GroupFolderItem, GroupFileListing } from './account/group_file';

export { GroupAlbumMediaService } from './account/group_album_media';
export type {
  AlbumMedia,
  AlbumMediaImage,
  AlbumMediaPage,
  AlbumMediaUrl,
  AlbumPhotoUrl,
} from './account/group_album_media';

export { MediaUrlService, mediaNodeFromElement, downloadUrlToFile } from './account/media_url';
export type { MediaElement, GroupFileDownload, DownloadOutcome } from './account/media_url';
export { PeerStatsService } from './account/peer_stats';
export { FlashTransferService } from './account/flash_transfer';
export {
  FlashTransferFilesService,
  FlashTransferDownloadManager,
  FlashTransferClient,
  FlashTransferResolver,
} from './account/flashtransfer';
export type {
  FlashListFile,
  FlashListResult,
  FlashSelection,
  FlashDownloadFile,
  FlashDownloadTask,
  FlashTaskStatus,
} from './account/flashtransfer';
export type { PeerStats } from './account/peer_stats';

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
export { ExportScheduler } from './account/export/scheduler';
export type {
  DressExportKinds,
  DressUsage,
  DressExportManifest,
  DressExportResult,
  DressExportFailure,
} from './account/export/dress_export';
export type {
  ScheduleConfig,
  ScheduleOptions,
  ScheduleConversation,
  ScheduleRangePreset,
  ScheduleRange,
  ScheduleOutcome,
  ScheduleTrigger,
  ScheduleInput,
  SchedulePatch,
  SchedulerDeps,
  ScheduledTask,
} from './account/export/scheduler';
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
  MarketPackDeps,
  MarketPackDownloadItem,
} from './account/export';

// ---- common (account-independent helpers) ----
export { VoiceTranscribeService, VOICE_MODELS, getVoiceModel } from './common/voice_transcribe';
export type {
  TranscribeModelInfo,
  TranscribeModelFile,
  TranscribeModelStatus,
  DownloadProgress as VoiceDownloadProgress,
} from './common/voice_transcribe';
export { getLogDir, getLogger, initLogger, logErrorContext } from './common/logger';
export type { Logger, LoggerContext, LogLevel } from './common/logger';
export { getHost, setHost } from './common/host';
export type { HostBridge, SaveTarget } from './common/host';
export { JsonStore, readJsonFile, writeJsonFileAtomic } from './common/json_store';
export {
  sanitizeSegment,
  uniqueName,
  safeRelSegments,
  type SanitizeSegmentOpts,
} from './common/path_sanitize';
export {
  TtsService,
  TTS_VENDOR_CATALOG,
  getTtsCatalogEntry,
  getTtsCapabilities,
} from '@weq/agentlab';
export type {
  TtsVendor,
  TtsProviderConfig,
  TtsRefClip,
  TtsSynthesizeOptions,
  TtsSynthesizeResult,
  TtsCapabilities,
  TtsVendorCatalogEntry,
} from '@weq/agentlab';
export { buildBotExport, probeBotWebUi } from './account/agentlab_export';
export type {
  BotExportInput,
  BotExportResult,
  BotExportLlmProvider,
} from './account/agentlab_export';
