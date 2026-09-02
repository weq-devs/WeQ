/**
 * `account/export` — chat export pipeline.
 *
 * 所有格式共享同一套骨架：`message_source` 分页取消息、`run_export` 流式写入、
 * `element_text` 渲染文本 / 媒体路径，各 exporter（JSON / JSONL / TXT / CSV /
 * XLSX / HTML / ChatLab）只实现自己的 framing + record 渲染。媒体补全 / 消息补全 /
 * 语音转写在 `media_export` / `msg_backfill`，任务调度在 `task_manager` +
 * `scheduler`（含定时导出）。
 */

export * from './types';
export {
  iterateGroupMessages,
  iterateC2cMessages,
  toExportedMessage,
  type IterateOptions,
} from './message_source';
export { bigintReplacer } from './serialize';
export { runGroupExport, type Framing } from './run_export';
export {
  elementToText,
  elementsToText,
  formatTime,
  messageToText,
  mediaRelPath,
  annotateLocalPaths,
} from './element_text';
export { exportGroupToJson, type JsonExportOptions } from './json_exporter';
export { exportGroupToJsonl } from './jsonl_exporter';
export {
  exportJsonConversation,
  type JsonMetaExportOptions,
  type JsonExportedMember,
  type JsonExportedMessage,
} from './json_meta_exporter';
export { exportGroupToTxt } from './txt_exporter';
export { exportGroupToCsv, csvFraming, renderCsvRow } from './csv_exporter';
export { exportToXlsx, type XlsxExportOptions } from './xlsx_exporter';
export { exportToHtml, type HtmlExportOptions } from './html_exporter';
export {
  exportSysFaces,
  exportMarketFaces,
  SYSFACE_SUBDIR,
  MFACE_SUBDIR,
} from './sysface_export';
export {
  exportQzone,
  type QzoneExportDeps,
  type QzoneExportOpts,
  type QzoneExportResult,
} from './qzone_export';
export {
  exportFriends,
  exportGroupMembers,
  type ContactsExportDeps,
  type ContactsFormat,
  type ContactsExportResult,
  type ExportFriendsOpts,
  type ExportGroupMembersOpts,
} from './contacts_export';
export {
  exportCollections,
  type CollectionExportDeps,
  type CollectionExportRow,
  type CollectionExportPic,
  type CollectionFormat,
  type CollectionExportResult,
  type ExportCollectionsOpts,
} from './collection_export';
export {
  avatarUrlForUin,
  iterateConv,
  resolveGroupSenders,
  resolveC2cSenders,
  fallbackSender,
  type SenderResolveDeps,
  type ResolvedSender,
  type ResolvedGroupMember,
} from './sender_resolve';
export {
  exportToChatlab,
  type ChatlabExportOptions,
  type ChatlabDeps,
  type ChatlabGroupMember,
} from './chatlab_exporter';
export {
  ChatlabMessageType,
  type ChatlabHeader,
  type ChatlabMember,
  type ChatlabMessage,
  type ChatlabRole,
} from './chatlab_types';
export { exportAvatars, type AvatarExportResult } from './avatar_export';
export {
  copyFoundMedia,
  decodeFoundVoices,
  transcribeFoundVoices,
  downloadMissingImages,
  downloadMissingVideos,
  downloadMissingFiles,
  MEDIA_SUBDIRS,
  TRANSCRIPTS_FILE,
  type DecodeSilk,
  type TranscribeVoiceFn,
  type TranscribeOutcome,
  type MediaStageResult,
  type StageProgress,
  type UrlDownloadCtx,
} from './media_export';
export {
  scanConvMedia,
  mediaDirsFromAccountDir,
  mediaDirsFromNtDataDir,
  type MediaKind,
  type MediaDirs,
  type MediaRef,
  type MediaScanResult,
  type KindCounts,
  type ScanOptions,
} from './media_scan';
export {
  ExportTaskManager,
  type ExportTask,
  type ExportTaskView,
  type TaskLogLevel,
  type TaskLogLine,
  type TaskProgress,
  type TaskStatus,
  type TaskStage,
  type StageKey,
  type MediaExportOptions,
  type MediaDeps,
  type MarketPackDeps,
  type MarketPackDownloadItem,
} from './task_manager';
export {
  backfillConversationMessages,
  buildBackfillWindows,
  type MessageBackfillDeps,
  type MessageBackfillOptions,
  type MessageBackfillSummary,
} from './msg_backfill';
export {
  ExportScheduler,
  computeNextRun,
  resolveRange,
  type ScheduleConfig,
  type ScheduleOptions,
  type ScheduleConversation,
  type ScheduleRangePreset,
  type ScheduleRange,
  type ScheduleOutcome,
  type ScheduleTrigger,
  type ScheduleInput,
  type SchedulePatch,
  type SchedulerDeps,
  type ScheduledTask,
} from './scheduler';
