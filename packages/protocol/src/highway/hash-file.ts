// 闪传上传的流式哈希:一遍顺序读文件,同时算 MD5 / 整文件 SHA1 / Sha1StateV,
// 多 GiB 文件也不会把整个文件读进内存。
// 结果与 buffered 的 computeHashes + computeSha1StateV 字节级一致(port 自 SL)。

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { Sha1Stream } from './sha1-stream';

/** 闪传 sliceupload 的分片大小(1 MiB)。 */
export const FLASH_SLICE_SIZE = 1024 * 1024;

export interface FlashFileHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  /** 每 1 MiB 累积 SHA1 中间 state(小端,不 finalize),最后一项是整文件 SHA1。 */
  sha1StateV: Uint8Array[];
  sliceCount: number;
}

/** 内存字节的 md5/sha1(缩略图等小数据用)。 */
export function computeHashes(bytes: Uint8Array): {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
} {
  const md5 = createHash('md5').update(Buffer.from(bytes)).digest();
  const sha1 = createHash('sha1').update(Buffer.from(bytes)).digest();
  return {
    md5: new Uint8Array(md5),
    sha1: new Uint8Array(sha1),
    md5Hex: md5.toString('hex'),
    sha1Hex: sha1.toString('hex'),
  };
}

/** 读取文件的一个区间(字节)。 */
export async function readFileRange(
  filePath: string,
  start: number,
  len: number,
): Promise<Uint8Array> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, start);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * 群 / 私聊文件上传用的流式哈希：整文件 md5 + sha1 + **前 `headLimit` 字节的 md5**，
 * 一次顺序 pass 完成，多个 GiB 的文件也不进内存。
 *
 * `headLimit` 的口径：QQ 的「前 10 MiB」校验用的是 `0x98A000`（10002432）——
 * 不是 `10 * 1024 * 1024`、也不是 `10^7`。用错会让服务端对超过该长度的文件
 * 的前段校验失败：字节传上去了，但永远 finalize 不成可下载的离线文件。
 * 只有私聊文件（0xE37_1700 的 `md510MCheckSum`）要它，群文件不需要。
 */
export const FILE_MD5_HEAD_LIMIT = 10002432;

export interface FileHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  /** 前 `headLimit` 字节的 md5；没给 `headLimit` 时为 null。 */
  headMd5: Uint8Array | null;
  fileSize: number;
}

export async function hashFileStreaming(
  filePath: string,
  options: { headLimit?: number } = {},
): Promise<FileHashes> {
  const { size } = await fsp.stat(filePath);
  const headLimit = options.headLimit && options.headLimit > 0 ? options.headLimit : 0;
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  const head = headLimit > 0 ? createHash('md5') : null;
  let headRemaining = headLimit;

  const handle = await fsp.open(filePath, 'r');
  try {
    let offset = 0;
    const buf = Buffer.alloc(FLASH_SLICE_SIZE);
    while (offset < size) {
      const len = Math.min(FLASH_SLICE_SIZE, size - offset);
      const { bytesRead } = await handle.read(buf, 0, len, offset);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      md5.update(chunk);
      sha1.update(chunk);
      if (head && headRemaining > 0) {
        const take = Math.min(headRemaining, bytesRead);
        head.update(chunk.subarray(0, take));
        headRemaining -= take;
      }
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }

  const md5Digest = md5.digest();
  const sha1Digest = sha1.digest();
  return {
    md5: new Uint8Array(md5Digest),
    sha1: new Uint8Array(sha1Digest),
    md5Hex: md5Digest.toString('hex'),
    sha1Hex: sha1Digest.toString('hex'),
    headMd5: head ? new Uint8Array(head.digest()) : null,
    fileSize: size,
  };
}

/**
 * 闪传 sliceupload 的流式哈希。等价于 computeHashes + computeSha1StateV(...),
 * 但一次顺序 pass 完成,不缓冲整个文件。
 */
export async function hashFlashFileStreaming(filePath: string): Promise<FlashFileHashes> {
  const { size } = await fsp.stat(filePath);
  const sliceCount = Math.ceil(size / FLASH_SLICE_SIZE);
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  const blockSha1 = new Sha1Stream();
  const sha1StateV: Uint8Array[] = [];

  let offset = 0;
  let sliceIndex = 0;
  while (offset < size) {
    const len = Math.min(FLASH_SLICE_SIZE, size - offset);
    const chunk = await readFileRange(filePath, offset, len);
    md5.update(Buffer.from(chunk));
    sha1.update(Buffer.from(chunk));
    blockSha1.update(chunk);
    if (sliceIndex !== sliceCount - 1) {
      sha1StateV.push(blockSha1.hash(true));
    }
    offset += len;
    sliceIndex += 1;
  }

  const sha1Digest = sha1.digest();
  if (sliceCount > 0) {
    sha1StateV.push(new Uint8Array(sha1Digest));
  }
  const md5Digest = md5.digest();

  return {
    md5: new Uint8Array(md5Digest),
    sha1: new Uint8Array(sha1Digest),
    md5Hex: md5Digest.toString('hex'),
    sha1Hex: sha1Digest.toString('hex'),
    sha1StateV,
    sliceCount,
  };
}
