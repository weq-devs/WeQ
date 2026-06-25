/**
 * `account/export` — chat export pipeline.
 *
 * Step 1: streaming JSON / JSONL / TXT exporters on a shared message-source +
 * streaming-runner core. Future steps add Excel / HTML exporters (consuming the
 * same {@link ExportedMessage} stream), media completion, and task scheduling.
 */

export * from './types';
export { iterateGroupMessages, iterateC2cMessages, toExportedMessage, type IterateOptions } from './message_source';
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
export { exportGroupToTxt } from './txt_exporter';
export { exportGroupToCsv, csvFraming, renderCsvRow } from './csv_exporter';
export { exportToXlsx, type XlsxExportOptions } from './xlsx_exporter';
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
  type TaskProgress,
  type TaskStatus,
  type TaskStage,
  type StageKey,
  type MediaExportOptions,
  type MediaDeps,
} from './task_manager';
