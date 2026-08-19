// 上传占位缩略图(png+jpg)。主文件下载入口(0x93d3 的下载 fileId)需要缩略图关联
// 才会被服务端填充,不传缩略图时自身上传的 fileset 无法被 download_fileset 解析。
// 缩略图用随机纯色 526x360 PNG(1x1 会被服务端拒,HTTP 400),每次随机颜色 SHA1
// 不同避免命中秒传缓存。手写 PNG 编码(zlib),不引入图像库。

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { OidbNative } from '../../transport';
import { buildSliceBody, postSliceupload } from '../../highway/sliceupload';
import { computeSha1StateV } from '../../highway/sha1-stream';
import { computeHashes } from '../../highway/hash-file';
import { ApplyUpload } from './apply-upload';
import { FLASH_APPID_JPG_THUMB, FLASH_APPID_PNG_THUMB, buildFileId } from './file-id';
import { PrepareUpload } from './prepare-upload';

// ---- 手写 PNG 编码 ----

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 width×height 随机纯色 PNG(8-bit RGB)。 */
export function generatePng(width: number, height: number): Buffer {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter none
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 1 + x * 3 + 1] = g;
      raw[off + 1 + x * 3 + 2] = b;
    }
  }
  const compressed = deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 上传一张占位缩略图。fileIndex 为缩略图在 fileset 内的序号(主文件之后递增),
 * 与 commit f6 对齐。缩略图小,sliceupload 1 片,Sha1StateV=[标准 SHA1]。
 */
export async function uploadThumbnail(
  nt: OidbNative,
  pid: number,
  filesetUuid: string,
  mainFileUuid: string,
  thumbType: 'png' | 'jpg',
  fileIndex: number,
): Promise<void> {
  // 526x360 是 QQ 客户端缩略图尺寸;1x1 会被服务端拒(HTTP 400,宽高太小)。
  const width = 526;
  const height = 360;
  const thumbBytes = generatePng(width, height);
  const appid = thumbType === 'png' ? FLASH_APPID_PNG_THUMB : FLASH_APPID_JPG_THUMB;
  const fileUuid = thumbType === 'png' ? randomUUID() : mainFileUuid;
  const fileName =
    thumbType === 'png'
      ? `${randomUUID().slice(0, 8)}_one.png`
      : `${createHash('md5').update(thumbBytes).digest('hex').slice(0, 32)}.jpg`;
  const hashes = computeHashes(new Uint8Array(thumbBytes));
  const fileSize = thumbBytes.length;
  const thumbFormatCode = thumbType === 'png' ? 26 : 2;

  const rkey = await PrepareUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid,
    fileName,
    fileSize,
    sha1: hashes.sha1Hex,
    fileIndex,
    formatCode: thumbFormatCode,
    thumbType,
    width,
    height,
  });
  if (rkey === null) return; // 秒传

  const fileId = buildFileId(hashes.sha1, fileSize, appid);
  await ApplyUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid,
    fileId,
    fileName,
    fileSize,
    md5: hashes.md5Hex,
    sha1: hashes.sha1Hex,
    fileIndex,
    formatCode: thumbFormatCode,
    thumbType,
    width,
    height,
  });

  const sha1StateV = computeSha1StateV(new Uint8Array(thumbBytes), 1, fileSize);
  const bodyBytes = buildSliceBody(
    {
      rkey,
      start: 0,
      end: fileSize - 1,
      sha1: new Uint8Array(hashes.sha1),
      sha1StateV,
      chunk: new Uint8Array(thumbBytes),
    },
    { appid },
  );
  await postSliceupload(bodyBytes, 'thumbnail sliceupload');
}
