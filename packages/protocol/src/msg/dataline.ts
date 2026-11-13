/** 数据线文本/文件通知，字段依据见 docs/develop/send-message.md 的设备会话章节。 */
import { encode, message } from '../protobuf';

const HEADER = message([
  { name: 'srcAppId', tag: 1, type: 'uint32' },
  { name: 'srcInstId', tag: 2, type: 'uint32' },
  { name: 'dstAppId', tag: 3, type: 'uint32' },
  { name: 'dstInstId', tag: 4, type: 'uint32' },
  { name: 'dstUin', tag: 5, type: 'uint64' },
  { name: 'srcUin', tag: 6, type: 'uint64' },
  { name: 'srcTerType', tag: 9, type: 'uint32' },
  { name: 'dstTerType', tag: 10, type: 'uint32' },
]);
const TEXT_ITEM = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'text', tag: 2, type: 'bytes' },
]);
const TEXT = message([{ name: 'items', tag: 1, type: TEXT_ITEM, repeated: true }]);
const GENERIC = message([
  { name: 'sessionId', tag: 1, type: 'uint64' },
  { name: 'size', tag: 2, type: 'uint32' },
  { name: 'index', tag: 3, type: 'uint32' },
  { name: 'type', tag: 4, type: 'uint32' },
  { name: 'buf', tag: 5, type: 'bytes' },
]);
const BODY = message([
  { name: 'subCmd', tag: 1, type: 'uint32' },
  { name: 'header', tag: 2, type: HEADER },
  { name: 'generic', tag: 6, type: GENERIC },
]);

export interface SendDatalineTarget {
  selfUin: number;
  /** 外层 SSO 路由使用本人真实 UID，设备伪 UID 仅标识本地会话。 */
  selfUid: string;
  deviceUid: string;
  /** 1 = 电脑，2 = 手机，3 = 平板。 */
  terminalType: 1 | 2 | 3;
}

export function validateDatalineTarget(target: SendDatalineTarget): void {
  if (!Number.isSafeInteger(target.selfUin) || target.selfUin <= 0)
    throw new Error('设备消息需要有效的本人 QQ 号');
  if (!target.selfUid.trim()) throw new Error('设备消息需要本人的真实 UID');
  if (!target.deviceUid.trim()) throw new Error('设备消息需要设备 UID');
  if (![1, 2, 3].includes(target.terminalType)) throw new Error('设备消息的终端类型无效');
}

export interface DatalineFileNotify {
  fileId: string;
  fileName: string;
  fileSize: number;
  /** 设备文件线上用前 FILE_MD5_HEAD_LIMIT 字节摘要，不是完整文件 MD5。 */
  headMd5: Uint8Array;
  originType: 0 | 1;
  sessionId: bigint;
  batchId: number;
}

const FILE_BODY = message([
  { name: 'subCmd', tag: 1, type: 'uint32' },
  {
    name: 'header',
    tag: 2,
    type: message(
      HEADER.fields.map((field) =>
        field.name === 'dstInstId' ? { ...field, force: true } : field,
      ),
    ),
  },
  {
    name: 'files',
    tag: 3,
    repeated: true,
    type: message([
      { name: 'sessionId', tag: 1, type: 'uint64' },
      { name: 'fileName', tag: 2, type: 'string' },
      { name: 'fileId', tag: 3, type: 'string' },
      { name: 'md5', tag: 4, type: 'bytes' },
      { name: 'fileSize', tag: 6, type: 'uint64' },
      { name: 'originalMd5', tag: 7, type: 'bytes' },
      { name: 'originType', tag: 8, type: 'uint32', force: true },
      { name: 'groupId', tag: 9, type: 'uint32', force: true },
      { name: 'groupSize', tag: 10, type: 'uint32' },
      { name: 'groupIndex', tag: 11, type: 'uint32', force: true },
      { name: 'batchId', tag: 21, type: 'uint32' },
      { name: 'groupFlag', tag: 22, type: 'uint32' },
    ]),
  },
]);

export function encodeDatalineFile(
  target: SendDatalineTarget,
  file: DatalineFileNotify,
): Uint8Array {
  validateDatalineTarget(target);
  if (!/^\/[0-9a-f-]{36}$/i.test(file.fileId)) throw new Error('设备文件索引无效');
  if (
    !file.fileName.trim() ||
    !Number.isSafeInteger(file.fileSize) ||
    file.fileSize <= 0 ||
    file.headMd5.length !== 16 ||
    ![0, 1].includes(file.originType) ||
    file.sessionId <= 0n ||
    file.sessionId >= 1n << 64n ||
    !Number.isInteger(file.batchId) ||
    file.batchId <= 0 ||
    file.batchId > 0xffffffff
  )
    throw new Error('设备文件通知参数无效');
  return encode(FILE_BODY, {
    subCmd: 1,
    header: {
      srcAppId: 1,
      srcInstId: 1,
      dstAppId: target.terminalType === 1 ? 1 : 1001,
      dstInstId: 0,
      dstUin: target.selfUin,
      srcUin: target.selfUin,
      srcTerType: 1,
      dstTerType: target.terminalType,
    },
    files: [
      {
        ...file,
        md5: file.headMd5,
        originalMd5: file.headMd5,
        groupId: 0,
        groupSize: 1,
        groupIndex: 0,
        groupFlag: 1,
      },
    ],
  });
}

export function encodeDatalineText(target: SendDatalineTarget, text: string): Uint8Array {
  validateDatalineTarget(target);
  if (!text.length) throw new Error('设备消息文本不能为空');
  return encode(BODY, {
    subCmd: 4,
    header: {
      srcAppId: 1,
      srcInstId: 1,
      dstAppId: target.terminalType === 1 ? 1 : 1001,
      dstInstId: 1,
      dstUin: target.selfUin,
      srcUin: target.selfUin,
      srcTerType: 1,
      dstTerType: target.terminalType,
    },
    generic: {
      sessionId: Date.now(),
      size: 1,
      index: 0,
      type: 1,
      buf: encode(TEXT, { items: [{ type: 1, text: new TextEncoder().encode(text) }] }),
    },
  });
}
