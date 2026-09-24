// 文件（群文件 / 私聊离线文件）发送 —— 与富媒体（图片/语音/视频）完全不同的
// 一条管线：老 OIDB 申请 + highway 裸帧 PUT + 发布/发送。
//   file-send.ts — 群文件（0x6D6_0 → highway 71 → 0x6D9_4）与
//                  私聊文件（0xE37_1700 → highway 95 → 0xE37_800 → PbSendMsg）。

export {
  sendGroupFile,
  sendPrivateFile,
  type FileNative,
  type GroupFileSendParams,
  type GroupFileSendResult,
  type PrivateFileSendParams,
  type PrivateFileSendResult,
} from './file-send';

// 四个命令的 schema（公开：调用方/测试要能离线拼包与解包）。
export {
  OIDB_GROUP_FILE_UPLOAD_REQ,
  OIDB_GROUP_FILE_UPLOAD_RESP,
  OIDB_GROUP_SEND_FILE_REQ,
  OIDB_OFFLINE_FILE_FINALIZE_REQ,
  OIDB_OFFLINE_FILE_FINALIZE_RESP,
  OIDB_PRIVATE_FILE_UPLOAD_REQ,
  OIDB_PRIVATE_FILE_UPLOAD_RESP,
} from '../oidb/file-upload-schemas';
