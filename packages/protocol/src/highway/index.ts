// highway —— QQ 富媒体 / 闪传的传输与哈希层(port 自 SL packages/protocol/src/highway)。
//   sha1-stream.ts   — 流式 SHA1(可输出中间 state)+ Sha1StateV 计算。
//   hash-file.ts     — 流式哈希(MD5 / 整文件 SHA1 / Sha1StateV,不缓冲文件)。
//   sliceupload.ts   — 闪传 sliceupload HTTP 直传(分片 body 构造 + POST + 校验)。
//   ntv2-schemas.ts  — 富媒体**上传**方向的 proto schema(0xE37_100 请求/响应 + highway 帧头)。
//   highway-client.ts— highway TCP 通道(0x6ff_501 会话 + 自定义帧 + 1MiB 分块 PUT)。
//   ntv2-upload.ts   — 上传编排(申请 → PUT → msgInfo 回写)。
//   media-upload.ts  — 按类型入口(图片 / 语音 / 视频)。
//   ptt-waveform.ts  — 语音波形(真条或合成条)。
//   image-format.ts  — 图片格式探测 + 罩底封面。

export { Sha1Stream, computeSha1StateV } from './sha1-stream';
export {
  computeHashes,
  hashFlashFileStreaming,
  hashFileStreaming,
  readFileRange,
  FILE_MD5_HEAD_LIMIT,
  FLASH_SLICE_SIZE,
} from './hash-file';
export type { FileHashes, FlashFileHashes } from './hash-file';
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

// ── 富媒体上传（NTV2 + highway TCP） ──
export {
  BufferChunkSource,
  buildHighwayExtend,
  buildHighwayHead,
  fetchHighwaySession,
  FileChunkSource,
  HIGHWAY_APP_ID,
  HIGHWAY_BLOCK_SIZE,
  HIGHWAY_SESSION_CMD,
  ipv4ToString,
  packHighwayFrame,
  unpackHighwayFrame,
  uploadHighwayHttp,
} from './highway-client';
export {
  buildGroupFileUploadExt,
  buildPrivateFileUploadExt,
  FILE_UPLOAD_EXT,
  GROUP_FILE_HIGHWAY_CMD,
  PRIVATE_FILE_HIGHWAY_CMD,
} from './file-upload-ext';
export type { FileUploadExtInput } from './file-upload-ext';
export type { ChunkSource, HighwaySession, HighwayUploadParams } from './highway-client';
export {
  finalizeMediaMsgInfo,
  makeClientRandomId,
  runNtv2Upload,
} from './ntv2-upload';
export type {
  MediaNative,
  MediaSubFileUpload,
  Ntv2UploadInfoInput,
  Ntv2UploadParams,
} from './ntv2-upload';
export {
  IMAGE_HIGHWAY_C2C,
  IMAGE_HIGHWAY_GROUP,
  IMAGE_OIDB_C2C,
  IMAGE_OIDB_GROUP,
  MEDIA_BUSINESS_TYPE,
  PTT_HIGHWAY_C2C,
  PTT_HIGHWAY_GROUP,
  PTT_OIDB_C2C,
  PTT_OIDB_GROUP,
  RICH_MEDIA_BUSINESS_TYPE,
  RICH_MEDIA_SERVICE_TYPE,
  uploadImageMsgInfo,
  uploadPttMsgInfo,
  uploadVideoMsgInfo,
  VIDEO_HIGHWAY_C2C,
  VIDEO_HIGHWAY_GROUP,
  VIDEO_OIDB_C2C,
  VIDEO_OIDB_GROUP,
  VIDEO_THUMB_HIGHWAY_C2C,
  VIDEO_THUMB_HIGHWAY_GROUP,
} from './media-upload';
export type {
  MediaSource,
  MediaUploadOptions,
  MediaUploadResult,
  MediaUploadTarget,
  UploadImageParams,
  UploadPttParams,
  UploadPttResult,
  UploadVideoParams,
} from './media-upload';
export {
  amplitudesFromPcmS16le,
  buildPttWaveform,
  decodePttWaveform,
  encodePttWaveform,
  pcmS16leFromWav,
  PTT_WAVEFORM_BINS,
  PTT_WAVEFORM_SILENCE,
  silentWaveform,
} from './ptt-waveform';
export type { PttWaveformBuild, PttWaveformSource } from './ptt-waveform';
export {
  detectImageFormat,
  makeSolidPng,
  PIC_FORMAT_BMP,
  PIC_FORMAT_GIF,
  PIC_FORMAT_JPEG,
  PIC_FORMAT_PNG,
  PIC_FORMAT_WEBP,
} from './image-format';
export type { ImageFormat } from './image-format';
export {
  C2C_SOURCE,
  HASH_SUM,
  HTTP_CONN,
  HTTP_CONN_REQ,
  HTTP_CONN_RESP,
  MSG_INFO_BODY,
  NTV2_EXT_BIZ_INFO,
  NTV2_RICH_MEDIA_HIGHWAY_EXT,
  NTV2_SUB_FILE_INFO_RESP,
  NTV2_UPLOAD_INFO,
  NTV2_UPLOAD_REQ,
  NTV2_UPLOAD_REQ_TOP,
  NTV2_UPLOAD_RESP_BODY,
  NTV2_UPLOAD_RESP_TOP,
  PIC_EXT_BIZ_INFO,
  PIC_EXT_DATA,
  PIC_URL_EXT_INFO,
  PICTURE_INFO,
  PTT_EXT_BIZ_INFO,
  PTT_WAVEFORM,
  REQ_DATA_HIGHWAY_HEAD,
  RESP_DATA_HIGHWAY_HEAD,
  TROOP_SOURCE,
  UPLOAD_MSG_INFO,
  VIDEO_EXT_BIZ_INFO,
} from './ntv2-schemas';
export type {
  Ntv2IPv4,
  Ntv2MsgInfoBody,
  Ntv2SubFileInfo,
  Ntv2UploadMsgInfo,
  Ntv2UploadResp,
} from './ntv2-schemas';
