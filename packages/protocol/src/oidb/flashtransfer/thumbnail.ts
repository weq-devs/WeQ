// 上传一张真实 PNG 缩略图(0x12a9_100 prepare / 0x12a9_103 apply + sliceupload 单片)。
// 主文件下载入口(0x93d3 的下载 fileId)需要缩略图关联才会被服务端填充。
// 抓包时序:prepare → 主文件上传 → apply → sliceupload,由 upload.ts 编排。
// 封面图 fileId 的 TTL 与主文件不同(8985599)。

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { OidbNative } from '../../transport';
import { buildSliceBody, postSliceupload } from '../../highway';
import { computeSha1StateV } from '../../highway';
import { computeHashes } from '../../highway';
import { ApplyUpload } from './apply-upload';
import { FLASH_APPID_PNG_THUMB, buildFileId } from './file-id';
import { PrepareUpload } from './prepare-upload';

/** prepare 后的缩略图状态,供 apply / sliceupload 两个阶段使用。 */
export interface PreparedThumbnail {
  nt: OidbNative;
  pid: number;
  filesetUuid: string;
  fileIndex: number;
  /** null 表示秒传命中(无需实际 sliceupload)。 */
  rkey: string | null;
  fileId: string;
  fileUuid: string;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  sha1Hex: string;
  sha1: Uint8Array;
  sha1StateV: Uint8Array[];
  chunk: Uint8Array;
  width: number;
  height: number;
  appid: number;
}

/** 阶段1:读取并校验 PNG,prepare 拿 rkey + 构造 fileId。 */
export async function prepareThumbnail(
    nt: OidbNative,
    pid: number,
    filesetUuid: string,
    thumbPath: string,
    fileIndex: number,
): Promise<PreparedThumbnail> {
  const thumbBytes = await fsp.readFile(thumbPath);
  if (
      thumbBytes.length < 24 ||
      !thumbBytes
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    throw new Error(`thumbnail is not a valid PNG: ${thumbPath}`);
  }
  const firstChunkLength = thumbBytes.readUInt32BE(8);
  if (
      thumbBytes.toString('ascii', 12, 16) !== 'IHDR' ||
      firstChunkLength < 8 ||
      thumbBytes.length < 24
  ) {
    throw new Error(`thumbnail PNG has no valid IHDR: ${thumbPath}`);
  }
  const width = thumbBytes.readUInt32BE(16);
  const height = thumbBytes.readUInt32BE(20);
  if (width === 0 || height === 0)
    throw new Error(`thumbnail PNG has invalid dimensions: ${thumbPath}`);
  const appid = FLASH_APPID_PNG_THUMB;
  const fileUuid = randomUUID();
  const fileName = `${randomUUID().slice(0, 8)}_one.png`;
  const hashes = computeHashes(new Uint8Array(thumbBytes));
  const fileSize = thumbBytes.length;

  const rkey = await PrepareUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid,
    fileName,
    fileSize,
    sha1: hashes.sha1Hex,
    fileIndex,
    formatCode: 26,
    thumbType: 'png',
    width,
    height,
  });

  return {
    nt,
    pid,
    filesetUuid,
    fileIndex,
    rkey,
    fileId: buildFileId(hashes.sha1, fileSize, appid),
    fileUuid,
    fileName,
    fileSize,
    md5Hex: hashes.md5Hex,
    sha1Hex: hashes.sha1Hex,
    sha1: new Uint8Array(hashes.sha1),
    sha1StateV: computeSha1StateV(new Uint8Array(thumbBytes), 1, fileSize),
    chunk: new Uint8Array(thumbBytes),
    width,
    height,
    appid,
  };
}

/** 阶段2:apply 注册 fileId 绑定进 fileset。 */
export async function applyThumbnail(thumb: PreparedThumbnail): Promise<void> {
  await ApplyUpload.invoke(thumb.nt, thumb.pid, {
    filesetUuid: thumb.filesetUuid,
    fileUuid: thumb.fileUuid,
    fileId: thumb.fileId,
    fileName: thumb.fileName,
    fileSize: thumb.fileSize,
    md5: thumb.md5Hex,
    sha1: thumb.sha1Hex,
    fileIndex: thumb.fileIndex,
    formatCode: 26,
    thumbType: 'png',
    width: thumb.width,
    height: thumb.height,
  });
}

/** 阶段3:单片 sliceupload 落盘。秒传命中(rkey=null)时跳过。 */
export async function sliceuploadThumbnail(thumb: PreparedThumbnail): Promise<void> {
  if (thumb.rkey === null) {
    return;
  }
  const bodyBytes = buildSliceBody(
      {
        rkey: thumb.rkey,
        start: 0,
        end: thumb.fileSize - 1,
        sha1: thumb.sha1,
        sha1StateV: thumb.sha1StateV,
        chunk: thumb.chunk,
      },
      { appid: thumb.appid },
  );

  await postSliceupload(bodyBytes, 'thumbnail sliceupload');
}
