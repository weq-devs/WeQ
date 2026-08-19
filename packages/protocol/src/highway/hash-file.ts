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
