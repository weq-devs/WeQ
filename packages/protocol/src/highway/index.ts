// highway —— QQ 富媒体 / 闪传的传输与哈希层(port 自 SL packages/protocol/src/highway)。
//   sha1-stream.ts — 流式 SHA1(可输出中间 state)+ Sha1StateV 计算。
//   hash-file.ts    — 闪传流式哈希(MD5 / 整文件 SHA1 / Sha1StateV,不缓冲文件)。
//   sliceupload.ts  — sliceupload HTTP 直传(分片 body 构造 + POST + 校验)。

export { Sha1Stream, computeSha1StateV } from './sha1-stream';
export {
  computeHashes,
  hashFlashFileStreaming,
  readFileRange,
  FLASH_SLICE_SIZE,
} from './hash-file';
export type { FlashFileHashes } from './hash-file';
export {
  buildSliceBody,
  postSliceupload,
  sliceuploadFile,
  FLASH_SHA1_STATE_V,
  FLASH_SLICE_PAYLOAD,
  FLASH_SLICE_UPLOAD_BODY,
  FLASH_SLICE_UPLOAD_RESP,
} from './sliceupload';
export type { SlicePart, SliceUploadOptions } from './sliceupload';
