// 闪传(FlashTransfer / fileset)协议与上传编排。
// 单个 OIDB 服务一个文件(0x93cf/0x93d0/0x93d1/0x93d3/0x93d7/0x12a9),传输层见 highway/。

export { ApplyFileset } from './apply-fileset';
export type { ApplyFilesetParams, ApplyFilesetResult, FlashUploaderInfo } from './apply-fileset';
export { PrepareUpload } from './prepare-upload';
export type { PrepareUploadParams } from './prepare-upload';
export { ApplyUpload } from './apply-upload';
export type { ApplyUploadParams } from './apply-upload';
export { CommitFile } from './commit-file';
export type { CommitEntry, CommitFileParams, CommitFileResult } from './commit-file';
export { CompleteFileset } from './complete-fileset';
export { SetFilesetStatus } from './set-status';
export { SendFlashMsg } from './send-flash';
export type { SendFlashMsgParams } from './send-flash';
export { GetFilesetDetail } from './get-fileset-detail';
export type { FlashFileInfo } from './get-fileset-detail';
export { createFlashFileset, finishFlashUpload, uploadFlashFiles } from './upload';
export type {
  FlashUploadItem,
  FlashUploadOptions,
  FlashUploadResult,
  FlashFilesetPending,
  FlashStagedItem,
} from './upload';
export { applyThumbnail, prepareThumbnail, sliceuploadThumbnail } from './thumbnail';
export type { PreparedThumbnail } from './thumbnail';
export {
  buildFileId,
  FLASH_APPID_MAIN,
  FLASH_APPID_PNG_THUMB,
  FLASH_APPID_JPG_THUMB,
} from './file-id';
export { fileTypeCode } from './file-type';
export type { FlashFileTypeCode } from './file-type';
