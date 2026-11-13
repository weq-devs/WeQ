/** 设备文件：旧 FTN 业务 38 / 客户端 104，不走私聊 NTV2 或 FileExtra。 */
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { encode, decode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { cleanNtLocalPath } from '../oidb/shared';
import { hashFileStreaming, FILE_MD5_HEAD_LIMIT, FileChunkSource } from '../highway';
import { sendMessage, type SendMessageReceipt } from '../msg/send';
import { validateDatalineTarget, type SendDatalineTarget } from '../msg/dataline';
import { buildDatalineBlock, parseDatalineBlockAck } from './dataline-block';

export const DATALINE_UPLOAD_CMD = 'OfflineFilleHandleSvr.pb_ftn_CMD_REQ_APPLY_UPLOAD_V3-1700';
export const DATALINE_UPLOAD_ATTEMPTS = 3;
export const DATALINE_UPLOAD_REQUEST = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'seq', tag: 2, type: 'uint32' },
  {
    name: 'upload',
    tag: 19,
    type: message([
      { name: 'senderUin', tag: 10, type: 'uint64' },
      { name: 'receiverUin', tag: 20, type: 'uint64' },
      { name: 'fileSize', tag: 30, type: 'uint64' },
      { name: 'fileName', tag: 40, type: 'string' },
      { name: 'headMd5', tag: 50, type: 'bytes' },
      { name: 'sha1', tag: 60, type: 'bytes' },
      { name: 'localPath', tag: 70, type: 'string' },
      { name: 'dangerLevel', tag: 80, type: 'uint32', force: true },
      { name: 'totalSpace', tag: 90, type: 'uint64', force: true },
    ]),
  },
  { name: 'businessId', tag: 101, type: 'uint32' },
  { name: 'clientType', tag: 102, type: 'uint32' },
]);
export const DATALINE_UPLOAD_RESPONSE = message([
  { name: 'command', tag: 1, type: 'uint32' },
  {
    name: 'upload',
    tag: 19,
    type: message([
      { name: 'retCode', tag: 10, type: 'int32' },
      { name: 'retMsg', tag: 20, type: 'string' },
      { name: 'ip', tag: 60, type: 'string' },
      { name: 'domain', tag: 70, type: 'string' },
      { name: 'port', tag: 80, type: 'uint32' },
      { name: 'uuid', tag: 90, type: 'string' },
      { name: 'key', tag: 100, type: 'bytes' },
      { name: 'fileExists', tag: 110, type: 'bool' },
      { name: 'blockSize', tag: 120, type: 'uint32' },
      { name: 'httpsPort', tag: 140, type: 'uint32' },
      { name: 'httpsDomain', tag: 150, type: 'string' },
    ]),
  },
]);

interface UploadReply {
  retCode?: number;
  retMsg?: string;
  ip?: string;
  domain?: string;
  port?: number;
  uuid?: string;
  key?: Uint8Array;
  fileExists?: boolean;
  blockSize?: number;
  httpsPort?: number;
  httpsDomain?: string;
}
export interface DatalineFileSendParams {
  target: SendDatalineTarget;
  filePath: string;
  fileName?: string;
  beforeSend?: () => void;
  log?: (message: string) => void;
}
export interface DatalineFileSendResult {
  fileId: string;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  fastUpload: boolean;
  /** 成功回执确认的文件负载字节数，不包含重试流量。 */
  uploadedBytes: number;
  sent: boolean;
  receipt: SendMessageReceipt;
}

async function readAcknowledgment(response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`设备文件上传 HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('设备文件上传响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65536) throw new Error('设备文件上传响应过大');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function postBlock(
  target: URL,
  packet: Uint8Array,
  beforeSend?: () => void,
): Promise<ReturnType<typeof parseDatalineBlockAck>> {
  for (let attempt = 0; attempt < DATALINE_UPLOAD_ATTEMPTS; attempt++) {
    beforeSend?.();
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(packet.length),
        },
        body: Uint8Array.from(packet),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      beforeSend?.();
      if (attempt === DATALINE_UPLOAD_ATTEMPTS - 1) throw error;
      await delay(200 * 2 ** attempt);
      continue;
    }
    if (
      [408, 500, 502, 503, 504].includes(response.status) &&
      attempt < DATALINE_UPLOAD_ATTEMPTS - 1
    ) {
      await response.body?.cancel().catch(() => undefined);
      beforeSend?.();
      await delay(200 * 2 ** attempt);
      continue;
    }
    return parseDatalineBlockAck(await readAcknowledgment(response));
  }
  throw new Error('设备文件上传重试次数已耗尽');
}

/** 完成上传后才发 FTN 通知；不假装已经建立 NFC 直连会话。 */
export async function sendDatalineFile(
  nt: TrpcNative,
  pid: number,
  params: DatalineFileSendParams,
): Promise<DatalineFileSendResult> {
  validateDatalineTarget(params.target);
  params.beforeSend?.();
  const filePath = cleanNtLocalPath(params.filePath);
  const info = await stat(filePath);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0)
    throw new Error('设备文件必须是非空的普通文件');
  const fileName = params.fileName?.trim() || basename(filePath);
  const hashes = await hashFileStreaming(filePath, { headLimit: FILE_MD5_HEAD_LIMIT });
  if (!hashes.headMd5) throw new Error('设备文件缺少分段 MD5');
  params.beforeSend?.();
  const replyBytes = await sendPacket(
    nt,
    pid,
    DATALINE_UPLOAD_CMD,
    encode(DATALINE_UPLOAD_REQUEST, {
      command: 1700,
      seq: 1,
      upload: {
        senderUin: params.target.selfUin,
        receiverUin: params.target.selfUin,
        fileSize: hashes.fileSize,
        fileName,
        headMd5: hashes.headMd5,
        sha1: hashes.sha1,
        localPath: filePath,
        dangerLevel: 0,
        totalSpace: 0,
      },
      businessId: 38,
      clientType: 104,
    }),
  );
  const { upload } = decode(DATALINE_UPLOAD_RESPONSE, replyBytes) as { upload?: UploadReply };
  if (!upload) throw new Error('设备文件上传申请响应无效');
  if ((upload.retCode ?? 0) !== 0)
    throw new Error(`设备文件上传申请被拒绝：code=${upload.retCode}`);
  const fileId = upload.uuid ?? '';
  if (!/^\/[0-9a-f-]{36}$/i.test(fileId)) throw new Error('设备文件上传申请缺少有效索引');
  params.beforeSend?.();
  let uploadedBytes = 0;
  if (!upload.fileExists) {
    if (!upload.key?.length) throw new Error('设备文件上传申请缺少票据');
    const headerBytes = 40 + upload.key.length + hashes.sha1.length;
    const blockSize = upload.blockSize ?? 131072;
    if (!Number.isSafeInteger(blockSize) || blockSize <= headerBytes || blockSize > 3 * 1024 * 1024)
      throw new Error('设备文件上传分块大小无效');
    const host = upload.httpsDomain || upload.domain || upload.ip;
    const port = upload.httpsDomain ? upload.httpsPort || 443 : upload.port || 80;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('设备文件上传节点无效');
    const endpoint = new URL(
      `${upload.httpsDomain ? 'https' : 'http'}://${host}:${port}/ftn_handler`,
    );
    const source = await FileChunkSource.open(filePath, hashes.fileSize);
    try {
      let offset = 0;
      while (offset < hashes.fileSize) {
        params.beforeSend?.();
        const data = await source.read(
          offset,
          Math.min(blockSize - headerBytes, hashes.fileSize - offset),
        );
        const built = buildDatalineBlock({
          uploadKey: upload.key,
          sha1: hashes.sha1,
          fileSize: BigInt(hashes.fileSize),
          offset: BigInt(offset),
          data,
          maxPacketBytes: blockSize,
        });
        const target = new URL(endpoint);
        target.searchParams.set('bmd5', built.blockMd5);
        params.beforeSend?.();
        const ack = await postBlock(target, built.packet, params.beforeSend);
        uploadedBytes += data.length;
        params.beforeSend?.();
        if (ack.complete) break;
        if (ack.nextOffset <= BigInt(offset) || ack.nextOffset > BigInt(hashes.fileSize))
          throw new Error('设备文件上传确认偏移无效，未继续发送');
        offset = Number(ack.nextOffset);
        params.log?.(`设备文件上传确认：${offset}/${hashes.fileSize}`);
      }
    } finally {
      await source.close();
    }
  }
  params.beforeSend?.();
  const receipt = await sendMessage(nt, pid, {
    dataline: params.target,
    elements: [],
    datalineFile: {
      fileId,
      fileName,
      fileSize: hashes.fileSize,
      headMd5: hashes.headMd5,
      originType: /\.(png|jpe?g|gif|webp|bmp)$/i.test(extname(fileName)) ? 1 : 0,
      sessionId: BigInt(`0x${randomBytes(6).toString('hex')}`) || 1n,
      batchId: Math.floor(Date.now() / 1000),
    },
  });
  return {
    fileId,
    fileName,
    fileSize: hashes.fileSize,
    md5Hex: hashes.md5Hex,
    fastUpload: uploadedBytes === 0,
    uploadedBytes,
    sent: receipt.ok,
    receipt,
  };
}
