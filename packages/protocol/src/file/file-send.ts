/**
 * 文件发送编排 —— 群文件 / 私聊文件。
 *
 * 两条管线都**不是** NTV2（和图片/语音/视频完全无关），而是「老 OIDB 申请 + highway
 * 裸帧 PUT + 发布/发送」：
 *
 *   群文件：
 *     1. `0x6D6_0` 申请：拿到 `fileId` / `checkKey` / `fileKey` / 上传节点 / `boolFileExist`；
 *     2. 没命中（`boolFileExist=false`）时 highway **cmdId 71** PUT 字节；
 *     3. `0x6D9_4` 把它**发布成群聊气泡**。
 *        （不能用 PbSendMsg 的 `transElem(24)` —— 服务端直接 `result=79` 拒收。）
 *
 *   私聊文件：
 *     1. `0xE37_1700` 申请：拿到 `uuid` / `mediaPlatformUploadKey` / `fileAddon` / 上传节点；
 *     2. 没命中时 highway **cmdId 95** PUT 字节；
 *     3. `0xE37_800` finalize：拿服务端签发的下载路由（**尽力而为**）；
 *     4. `MessageSvc.PbSendMsg`（`trans0x211` 路由 + `msgContent` 里的 `FileExtra`）发出去。
 *
 * 两个真机坑（写在 `./file-upload-ext` 与 `../oidb/file-upload-schemas` 的注释里）：
 * extend 的 `busiBuff` 不能带旧 `busId`；私聊「前 10 MiB」md5 的上限是 `0x98A000`。
 *
 * 大文件全程走 `FileChunkSource` 流式读写，不进内存。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  buildGroupFileUploadExt,
  buildPrivateFileUploadExt,
  fetchHighwaySession,
  FileChunkSource,
  GROUP_FILE_HIGHWAY_CMD,
  hashFileStreaming,
  FILE_MD5_HEAD_LIMIT,
  ipv4ToString,
  PRIVATE_FILE_HIGHWAY_CMD,
  uploadHighwayHttp,
} from '../highway';
import { invokeOidb, type OidbSpec } from '../oidb/invoke';
import {
  OIDB_GROUP_FILE_UPLOAD_REQ,
  OIDB_GROUP_FILE_UPLOAD_RESP,
  OIDB_GROUP_SEND_FILE_REQ,
  OIDB_PRIVATE_FILE_UPLOAD_REQ,
  OIDB_PRIVATE_FILE_UPLOAD_RESP,
  OIDB_OFFLINE_FILE_FINALIZE_REQ,
  OIDB_OFFLINE_FILE_FINALIZE_RESP,
} from '../oidb/file-upload-schemas';
import { ensureRetCodeZero, toInt } from '../oidb/shared';
import { encode, message } from '../protobuf';
import { sendC2cFileMessage, type SendMessageReceipt } from '../msg/send';
import { FILE_EXTRA } from '../msg/schemas';
import type { OidbNative, TrpcNative } from '../transport';

/** 文件上传需要的 native 能力：OIDB（申请/发布/finalize）+ 原始 SSO 包（highway 会话 / PbSendMsg）。 */
export type FileNative = OidbNative & TrpcNative;

// ───────────────────────── 群文件 — 0x6D6_0 / 71 / 0x6D9_4 ─────────────────────────

interface GroupFileUploadResp {
  retCode?: number;
  retMsg?: string;
  clientWording?: string;
  uploadIp?: string;
  serverDns?: string;
  busId?: number;
  fileId?: string;
  checkKey?: Uint8Array;
  fileKey?: Uint8Array;
  boolFileExist?: boolean;
  uploadPort?: number;
}

interface GroupFileUploadParams {
  groupId: number;
  fileName: string;
  folderId: string;
  fileSize: number;
  fileSha1: Uint8Array;
  fileMd5: Uint8Array;
}

const UploadGroupFile = {
  command: 0x6d6,
  subCommand: 0,
  uinForm: true,
  reqSchema: OIDB_GROUP_FILE_UPLOAD_REQ,
  respSchema: OIDB_GROUP_FILE_UPLOAD_RESP,
  serialize: (p: GroupFileUploadParams): Record<string, unknown> => ({
    file: {
      groupUin: p.groupId,
      appId: 4,
      busId: 102,
      entrance: 6,
      targetDirectory: p.folderId,
      fileName: p.fileName,
      localDirectory: `/${p.fileName}`,
      fileSize: BigInt(p.fileSize),
      fileSha1: p.fileSha1,
      fileSha3: new Uint8Array(0),
      fileMd5: p.fileMd5,
      field15: true,
    },
  }),
  deserialize: (body: Record<string, unknown>): GroupFileUploadResp => {
    const upload = body.upload as GroupFileUploadResp | undefined;
    if (!upload) throw new Error('群文件上传响应缺少 upload');
    return upload;
  },
} satisfies OidbSpec<GroupFileUploadParams, GroupFileUploadResp>;

/** 发布只关心成败，响应体不解（`deserialize` 直接丢弃）。 */
const PUBLISH_EMPTY_RESP = message([]);

const PublishGroupFile = {
  command: 0x6d9,
  subCommand: 4,
  reqSchema: OIDB_GROUP_SEND_FILE_REQ,
  respSchema: PUBLISH_EMPTY_RESP,
  serialize: (p: { groupId: number; fileId: string }): Record<string, unknown> => ({
    body: {
      groupUin: p.groupId,
      type: 2,
      info: {
        busiType: 102,
        fileId: p.fileId,
        // 31 位随机数（Lagrange 同）；field5=true 是服务端认这条分支的判别位。
        field3: Math.floor(Math.random() * 0x7fffffff) >>> 0,
        field5: true,
      },
    },
  }),
  deserialize: (): void => {},
} satisfies OidbSpec<{ groupId: number; fileId: string }, void>;

/** 群文件上传 + 发送参数。 */
export interface GroupFileSendParams {
  /** 目标群号。 */
  groupId: number;
  /** 本机文件路径。 */
  filePath: string;
  /** 收端显示的文件名；缺省取路径 basename。 */
  fileName?: string;
  /** 群文件目录；缺省 `/`。 */
  folderId?: string;
  /** 自己账号的 uin（highway 帧头 / extend 要用）。 */
  selfUin: number | string;
  /** 上传完是否发布成群聊气泡；缺省 true。 */
  publish?: boolean;
  log?: (message: string) => void;
}

export interface GroupFileSendResult {
  fileId: string;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  sha1Hex: string;
  /** 服务端已按 md5 持有该文件（没传字节）。 */
  fastUpload: boolean;
  /** 是否真的发布到了群聊（`publish: false` 时为 false）。 */
  published: boolean;
}

/**
 * 上传一个文件到群文件（并默认发布成群聊气泡）。
 */
export async function sendGroupFile(
  nt: FileNative,
  pid: number,
  params: GroupFileSendParams,
): Promise<GroupFileSendResult> {
  const log = params.log;
  const groupId = params.groupId;
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`群文件需要合法的 groupId，收到 ${String(groupId)}`);
  }
  const senderUin = toInt(params.selfUin);
  if (senderUin <= 0) throw new Error('群文件需要合法的 selfUin');

  const stat = await fsp.stat(params.filePath);
  if (stat.size === 0) throw new Error('群文件不能为空');
  const fileName = params.fileName?.trim() || path.basename(params.filePath) || 'file.bin';
  const folderId = params.folderId?.trim() || '/';

  const hashes = await hashFileStreaming(params.filePath);
  const upload = await invokeOidb(nt, pid, UploadGroupFile, {
    groupId,
    fileName,
    folderId,
    fileSize: hashes.fileSize,
    fileSha1: hashes.sha1,
    fileMd5: hashes.md5,
  });
  ensureRetCodeZero('群文件上传申请', upload.retCode, upload.retMsg, upload.clientWording);

  const fileId = typeof upload.fileId === 'string' && upload.fileId ? upload.fileId : '';
  if (!fileId) throw new Error('群文件上传响应缺少 fileId');

  const fastUpload = upload.boolFileExist === true;
  if (!fastUpload) {
    const host =
      (typeof upload.uploadIp === 'string' && upload.uploadIp) ||
      (typeof upload.serverDns === 'string' && upload.serverDns) ||
      '';
    const port = toInt(upload.uploadPort);
    if (!host || port <= 0) throw new Error('群文件上传节点无效（uploadIp/serverDns + port）');

    const extend = buildGroupFileUploadExt({
      senderUin,
      groupId,
      fileName,
      fileSize: hashes.fileSize,
      md5: hashes.md5,
      fileId,
      uploadKey: upload.fileKey instanceof Uint8Array ? upload.fileKey : new Uint8Array(0),
      checkKey: upload.checkKey instanceof Uint8Array ? upload.checkKey : new Uint8Array(0),
      uploadHost: host,
      uploadPort: port,
    });
    // 先拿会话再开文件句柄：会话失败时不泄漏已打开的 fd（uploadHighwayHttp 拥有 source）。
    const session = await fetchHighwaySession(nt, pid);
    const source = await FileChunkSource.open(params.filePath, hashes.fileSize);
    await uploadHighwayHttp({
      session,
      uin: String(senderUin),
      commandId: GROUP_FILE_HIGHWAY_CMD,
      source,
      fileMd5: hashes.md5,
      extend,
      log,
    });
  } else {
    log?.('群文件命中秒传（服务端已持有该 md5，未传字节）');
  }

  const publish = params.publish !== false;
  if (publish) await invokeOidb(nt, pid, PublishGroupFile, { groupId, fileId });

  return {
    fileId,
    fileName,
    fileSize: hashes.fileSize,
    md5Hex: hashes.md5Hex,
    sha1Hex: hashes.sha1Hex,
    fastUpload,
    published: publish,
  };
}

// ───────────────────────── 私聊文件 — 0xE37_1700 / 95 / 0xE37_800 / PbSendMsg ─────────────────────────

interface PrivateFileUploadResp {
  retCode?: number;
  retMsg?: string;
  uploadIp?: string;
  uploadDomain?: string;
  uploadPort?: number;
  uuid?: string;
  uploadKey?: Uint8Array;
  boolFileExist?: boolean;
  uploadIpList?: string[];
  uploadHttpsPort?: number;
  uploadHttpsDomain?: string;
  uploadDns?: string;
  fileAddon?: string;
  rtpMediaPlatformUploadAddress?: {
    outIp?: number;
    outPort?: number;
    inIp?: number;
    inPort?: number;
  }[];
  mediaPlatformUploadKey?: Uint8Array;
}

interface PrivateFileUploadParams {
  senderUid: string;
  receiverUid: string;
  fileName: string;
  fileSize: number;
  fileSha1: Uint8Array;
  fileMd5: Uint8Array;
  md510MCheckSum: Uint8Array;
}

const UploadPrivateFile = {
  command: 0xe37,
  subCommand: 1700,
  reqSchema: OIDB_PRIVATE_FILE_UPLOAD_REQ,
  respSchema: OIDB_PRIVATE_FILE_UPLOAD_RESP,
  serialize: (p: PrivateFileUploadParams): Record<string, unknown> => ({
    command: 1700,
    seq: 0,
    upload: {
      senderUid: p.senderUid,
      receiverUid: p.receiverUid,
      fileSize: p.fileSize,
      fileName: p.fileName,
      md510MCheckSum: p.md510MCheckSum,
      sha1CheckSum: p.fileSha1,
      localPath: '/',
      md5CheckSum: p.fileMd5,
      sha3CheckSum: new Uint8Array(0),
    },
    businessId: 3,
    clientType: 1,
    flagSupportMediaPlatform: 1,
  }),
  deserialize: (body: Record<string, unknown>): PrivateFileUploadResp => {
    const upload = body.upload as PrivateFileUploadResp | undefined;
    if (!upload) throw new Error('私聊文件上传响应缺少 upload');
    return upload;
  },
} satisfies OidbSpec<PrivateFileUploadParams, PrivateFileUploadResp>;

interface FinalizeParams {
  senderUid: string;
  receiverUid: string;
  fileUuid: string;
  fileHash: string;
}

interface FinalizeMetadata {
  field3?: number;
  field100?: Uint8Array;
  field101?: Uint8Array;
  field110?: number;
  timestamp1?: number;
}

const FinalizeOfflineFile = {
  command: 0xe37,
  subCommand: 800,
  reqSchema: OIDB_OFFLINE_FILE_FINALIZE_REQ,
  respSchema: OIDB_OFFLINE_FILE_FINALIZE_RESP,
  serialize: (p: FinalizeParams): Record<string, unknown> => ({
    subCommand: 800,
    field2: 0,
    body: {
      senderUid: p.senderUid,
      receiverUid: p.receiverUid,
      fileUuid: p.fileUuid,
      fileHash: p.fileHash,
    },
    field101: 3,
    field102: 1,
    field200: 1,
  }),
  deserialize: (body: Record<string, unknown>): FinalizeMetadata => {
    const inner = body.body as Record<string, unknown> | undefined;
    return (inner?.metadata as FinalizeMetadata | undefined) ?? {};
  },
} satisfies OidbSpec<FinalizeParams, FinalizeMetadata>;

/** 私聊文件上传 + 发送参数。 */
export interface PrivateFileSendParams {
  /** 对方 uid。 */
  userUid: string;
  /** 自己账号的 uid（finalize 与 FileExtra.field6 都要）。 */
  selfUid: string;
  /** 本机文件路径。 */
  filePath: string;
  /** 收端显示的文件名；缺省取路径 basename。 */
  fileName?: string;
  /** 自己账号的 uin（highway 帧头要用）。 */
  selfUin: number | string;
  /** 上传完是否发出去；缺省 true。 */
  send?: boolean;
  log?: (message: string) => void;
}

export interface PrivateFileSendResult {
  fileId: string;
  fileHash: string;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  /** 服务端已按 md5 持有该文件（没传字节）。 */
  fastUpload: boolean;
  /** `0xE37_800` finalize 是否成功（失败只是少了 field6，不影响下载）。 */
  finalized: boolean;
  /** 是否真的发出去了（`send: false` 时为 false）。 */
  sent: boolean;
  receipt?: SendMessageReceipt;
}

/**
 * 上传一个文件并私聊发出去。
 *
 * 顺序：申请 → highway PUT → finalize（尽力而为）→ PbSendMsg。
 */
export async function sendPrivateFile(
  nt: FileNative,
  pid: number,
  params: PrivateFileSendParams,
): Promise<PrivateFileSendResult> {
  const log = params.log;
  const userUid = params.userUid?.trim();
  const selfUid = params.selfUid?.trim();
  if (!userUid) throw new Error('私聊文件需要 userUid');
  if (!selfUid) throw new Error('私聊文件需要 selfUid');
  const senderUin = toInt(params.selfUin);
  if (senderUin <= 0) throw new Error('私聊文件需要合法的 selfUin');

  const stat = await fsp.stat(params.filePath);
  if (stat.size === 0) throw new Error('私聊文件不能为空');
  const fileName = params.fileName?.trim() || path.basename(params.filePath) || 'file.bin';

  // 「前 10 MiB」的上限是 0x98A000（见 hash-file 注释），只有私聊要它。
  const hashes = await hashFileStreaming(params.filePath, { headLimit: FILE_MD5_HEAD_LIMIT });
  if (!hashes.headMd5) throw new Error('私聊文件缺少 md510M 校验和');

  const upload = await invokeOidb(nt, pid, UploadPrivateFile, {
    senderUid: selfUid,
    receiverUid: userUid,
    fileName,
    fileSize: hashes.fileSize,
    fileSha1: hashes.sha1,
    fileMd5: hashes.md5,
    md510MCheckSum: hashes.headMd5,
  });
  ensureRetCodeZero('私聊文件上传申请', upload.retCode, upload.retMsg);

  const fileId = typeof upload.uuid === 'string' && upload.uuid ? upload.uuid : '';
  if (!fileId) throw new Error('私聊文件上传响应缺少 uuid');
  const fileHash = typeof upload.fileAddon === 'string' ? upload.fileAddon : '';

  const fastUpload = upload.boolFileExist === true;
  if (!fastUpload) {
    // 新版服务端已经不填老 `uploadIp`，主来源是 rtpMediaPlatformUploadAddress[0]
    // 的 inIp/inPort（LAN，和 OIDB 端点同一个 DC，正是 highway PUT 要连的那个）。
    const rtp = upload.rtpMediaPlatformUploadAddress?.[0];
    const rtpIp =
      rtp && typeof rtp.inIp === 'number' && rtp.inIp !== 0 ? ipv4ToString(rtp.inIp) : '';
    const rtpPort = rtp && typeof rtp.inPort === 'number' && rtp.inPort > 0 ? rtp.inPort : 0;
    const ipListFirst =
      Array.isArray(upload.uploadIpList) && upload.uploadIpList.length > 0
        ? upload.uploadIpList[0]!
        : '';
    const httpsOnly = !rtpIp && !upload.uploadIp && !upload.uploadDomain && !ipListFirst;
    const host =
      rtpIp ||
      (typeof upload.uploadIp === 'string' && upload.uploadIp) ||
      (typeof upload.uploadDomain === 'string' && upload.uploadDomain) ||
      ipListFirst ||
      (typeof upload.uploadHttpsDomain === 'string' && upload.uploadHttpsDomain) ||
      (typeof upload.uploadDns === 'string' && upload.uploadDns) ||
      '';
    const port = rtpIp
      ? rtpPort
      : httpsOnly && toInt(upload.uploadHttpsPort) > 0
        ? toInt(upload.uploadHttpsPort)
        : toInt(upload.uploadPort);
    if (!host || port <= 0) throw new Error('私聊文件上传节点无效（rtp/uploadIp + port）');

    const extend = buildPrivateFileUploadExt({
      senderUin,
      fileName,
      fileSize: hashes.fileSize,
      md5: hashes.md5,
      sha1: hashes.sha1,
      fileId,
      uploadKey:
        upload.mediaPlatformUploadKey instanceof Uint8Array
          ? upload.mediaPlatformUploadKey
          : upload.uploadKey instanceof Uint8Array
            ? upload.uploadKey
            : new Uint8Array(0),
      uploadHost: host,
      uploadPort: port,
    });
    const session = await fetchHighwaySession(nt, pid);
    const source = await FileChunkSource.open(params.filePath, hashes.fileSize);
    await uploadHighwayHttp({
      session,
      uin: String(senderUin),
      commandId: PRIVATE_FILE_HIGHWAY_CMD,
      source,
      fileMd5: hashes.md5,
      extend,
      log,
    });
  } else {
    log?.('私聊文件命中秒传（服务端已持有该 md5，未传字节）');
  }

  // finalize 是**尽力而为**：`file` 本身已够收端下载，`field6` 只是加强。
  // 失败只记日志，不让整条发送跟着失败。
  let meta: FinalizeMetadata | null = null;
  try {
    meta = await invokeOidb(nt, pid, FinalizeOfflineFile, {
      senderUid: selfUid,
      receiverUid: userUid,
      fileUuid: fileId,
      fileHash,
    });
  } catch (err) {
    log?.(
      `私聊文件 finalize（0xE37_800）失败，改发不带 field6 的版本: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fileExtra: Record<string, unknown> = {
    file: {
      fileType: 0,
      fileUuid: fileId,
      fileMd5: hashes.md5,
      fileName,
      fileSize: BigInt(hashes.fileSize),
      subcmd: 1,
      dangerEvel: 0,
      expireTime: nowSec + 7 * 24 * 60 * 60,
      fileHash,
    },
  };
  if (meta) {
    fileExtra.field6 = {
      field2: {
        field1: meta.field110,
        fileUuid: fileId,
        fileName,
        field6: meta.field3,
        field7: meta.field101,
        field8: meta.field100,
        timestamp1: meta.timestamp1,
        fileHash,
        selfUid,
        destUid: userUid,
      },
    };
  }

  const shouldSend = params.send !== false;
  if (!shouldSend) {
    return {
      fileId,
      fileHash,
      fileName,
      fileSize: hashes.fileSize,
      md5Hex: hashes.md5Hex,
      fastUpload,
      finalized: meta !== null,
      sent: false,
    };
  }

  const receipt = await sendC2cFileMessage(nt, pid, {
    userUid,
    fileExtra: encode(FILE_EXTRA, fileExtra),
  });

  return {
    fileId,
    fileHash,
    fileName,
    fileSize: hashes.fileSize,
    md5Hex: hashes.md5Hex,
    fastUpload,
    finalized: meta !== null,
    sent: receipt.ok,
    receipt,
  };
}
