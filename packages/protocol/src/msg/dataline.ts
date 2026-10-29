/** 数据线文本格式，字段依据见 docs/develop/send-message.md 的设备会话章节。 */
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
  deviceUid: string;
  /** 1 = 电脑，2 = 手机，3 = 平板。 */
  terminalType: 1 | 2 | 3;
}

export function encodeDatalineText(target: SendDatalineTarget, text: string): Uint8Array {
  if (!Number.isSafeInteger(target.selfUin) || target.selfUin <= 0)
    throw new Error('设备消息需要有效的本人 QQ 号');
  if (!target.deviceUid.trim()) throw new Error('设备消息需要设备 UID');
  if (![1, 2, 3].includes(target.terminalType)) throw new Error('设备消息的终端类型无效');
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
