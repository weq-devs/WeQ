import { createHash } from 'node:crypto';

export const DATALINE_FTN_MAGIC = 0xabcd9876;
export const DATALINE_FTN_UPLOAD_COMMAND = 1007;
const MAX_U64 = (1n << 64n) - 1n;
const LOW_U32 = 0xffffffffn;

/** FTN handler 整包大小包括票据和协议头，不是纯文件块长度。 */
export function buildDatalineBlock(params: {
  uploadKey: Uint8Array;
  sha1: Uint8Array;
  fileSize: bigint;
  offset: bigint;
  data: Uint8Array;
  maxPacketBytes: number;
}): { packet: Uint8Array; blockMd5: string } {
  const { uploadKey, sha1, fileSize, offset, data } = params;
  if (!uploadKey.length || uploadKey.length > 65535) throw new Error('设备文件上传票据长度无效');
  if (sha1.length !== 20) throw new Error('设备文件上传需要 SHA-1');
  if (
    fileSize <= 0n ||
    fileSize > MAX_U64 ||
    offset < 0n ||
    offset > fileSize ||
    !data.length ||
    offset + BigInt(data.length) > fileSize
  )
    throw new Error('设备文件分块范围无效');
  const headerBytes = 40 + uploadKey.length + sha1.length;
  const packetBytes = headerBytes + data.length;
  if (!Number.isSafeInteger(params.maxPacketBytes) || packetBytes > params.maxPacketBytes)
    throw new Error('设备文件分块超过服务端整包限额');
  const packet = Buffer.alloc(packetBytes);
  packet.writeUInt32BE(DATALINE_FTN_MAGIC, 0);
  packet.writeUInt32BE(DATALINE_FTN_UPLOAD_COMMAND, 4);
  packet.writeUInt32BE(packetBytes - 16, 12);
  let at = 16;
  packet.writeUInt16BE(uploadKey.length, at);
  at += 2;
  packet.set(uploadKey, at);
  at += uploadKey.length;
  packet.writeUInt16BE(sha1.length, at);
  at += 2;
  packet.set(sha1, at);
  at += sha1.length;
  // 旧 32 位字段在前，高字是后加的兼容扩展，不能按两个连续 u64 编码。
  for (const word of [
    fileSize & LOW_U32,
    offset & LOW_U32,
    BigInt(data.length),
    fileSize >> 32n,
    offset >> 32n,
  ]) {
    packet.writeUInt32BE(Number(word), at);
    at += 4;
  }
  packet.set(data, at);
  return { packet, blockMd5: createHash('md5').update(data).digest('hex') };
}

export function parseDatalineBlockAck(bytes: Uint8Array): {
  complete: boolean;
  nextOffset: bigint;
} {
  const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (packet.length < 16 || packet.readUInt32BE(0) !== DATALINE_FTN_MAGIC)
    throw new Error('设备文件上传响应头无效');
  const result = packet.readUInt32BE(4);
  if (result !== 0) throw new Error(`设备文件上传被拒绝：code=${result}`);
  const bodyLength = packet.readUInt32BE(12);
  if (bodyLength < 9 || bodyLength > packet.length - 16) throw new Error('设备文件上传响应不完整');
  return {
    complete: packet[16] === 1,
    nextOffset: BigInt(packet.readUInt32BE(17)) | (BigInt(packet.readUInt32BE(21)) << 32n),
  };
}
