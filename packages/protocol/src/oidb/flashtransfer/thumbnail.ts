// 上传一张真实缩略图(0x12a9_100 prepare / 0x12a9_103 apply + sliceupload 单片)。
// 主文件下载入口(0x93d3 的下载 fileId)需要缩略图关联才会被服务端填充。
// 抓包时序:prepare → 主文件上传 → apply → sliceupload,由 upload.ts 编排。
// 封面图 fileId 的 TTL 与主文件不同(8985599)。
//
// 支持 PNG / JPEG 两种封面:格式由本地字节的 magic 探测。用户自定义封面走「直通」
// (渲染层不再重绘/压缩),所以这里必须两种都认。JPEG 用 appid 14902 + formatCode 2,
// PNG 用 appid 14903 + formatCode 26(与 prepare / apply 的 isJpg 分支一致)。

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { OidbNative } from '../../transport';
import { buildSliceBody, postSliceupload } from '../../highway';
import { computeSha1StateV } from '../../highway';
import { computeHashes } from '../../highway';
import { detectImageFormat, PIC_FORMAT_JPEG, PIC_FORMAT_PNG } from '../../highway';
import { ApplyUpload } from './apply-upload';
import { FLASH_APPID_JPG_THUMB, FLASH_APPID_PNG_THUMB, buildFileId } from './file-id';
import { PrepareUpload } from './prepare-upload';

/** 缩略图类型:与 PrepareUpload / ApplyUpload 的 `thumbType` 取值一致。 */
export type FlashThumbType = 'png' | 'jpg';

/** 探测封面字节的图片格式;只认 PNG / JPEG(尺寸非法或其它格式返回 null)。 */
export function detectThumbType(bytes: Uint8Array): FlashThumbType | null {
  const { format, width, height } = detectImageFormat(bytes);
  if (width <= 0 || height <= 0) return null;
  if (format === PIC_FORMAT_PNG) return 'png';
  if (format === PIC_FORMAT_JPEG) return 'jpg';
  return null;
}

/** prepare 后的缩略图状态,供 apply / sliceupload 两个阶段使用。 */
export interface PreparedThumbnail {
  nt: OidbNative;
  pid: number;
  filesetUuid: string;
  fileIndex: number;
  /** 封面格式(png / jpg),决定 prepare / apply 的 thumbType 与 fileId appid。 */
  thumbType: FlashThumbType;
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
  /** apply(0x12a9_103) 响应里规范化后的 filesetWrap 原始字节，sliceupload f107.f101 原样回带。 */
  filesetRef: Uint8Array | null;
}

/** 阶段1:读取并校验 PNG / JPEG,prepare 拿 rkey + 构造 fileId。 */
export async function prepareThumbnail(
  nt: OidbNative,
  pid: number,
  filesetUuid: string,
  thumbPath: string,
  fileIndex: number,
): Promise<PreparedThumbnail> {
  const thumbBytes = await fsp.readFile(thumbPath);
  const thumbType = detectThumbType(new Uint8Array(thumbBytes));
  if (thumbType === null) {
    throw new Error(`thumbnail must be a valid PNG or JPEG: ${thumbPath}`);
  }
  const { width, height } = detectImageFormat(new Uint8Array(thumbBytes));
  const isJpg = thumbType === 'jpg';
  const appid = isJpg ? FLASH_APPID_JPG_THUMB : FLASH_APPID_PNG_THUMB;
  const fileUuid = randomUUID();
  const fileName = `${randomUUID().slice(0, 8)}_one.${isJpg ? 'jpg' : 'png'}`;
  const hashes = computeHashes(new Uint8Array(thumbBytes));
  const fileSize = thumbBytes.length;

  const rkey = await PrepareUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid,
    fileName,
    fileSize,
    sha1: hashes.sha1Hex,
    fileIndex,
    formatCode: isJpg ? 2 : 26,
    thumbType,
    width,
    height,
  });

  return {
    nt,
    pid,
    filesetUuid,
    fileIndex,
    thumbType,
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
    filesetRef: null,
  };
}

/** 阶段2:apply 注册 fileId 绑定进 fileset。 */
export async function applyThumbnail(thumb: PreparedThumbnail): Promise<void> {
  const isJpg = thumb.thumbType === 'jpg';
  thumb.filesetRef = await ApplyUpload.invoke(thumb.nt, thumb.pid, {
    filesetUuid: thumb.filesetUuid,
    fileUuid: thumb.fileUuid,
    fileId: thumb.fileId,
    fileName: thumb.fileName,
    fileSize: thumb.fileSize,
    md5: thumb.md5Hex,
    sha1: thumb.sha1Hex,
    fileIndex: thumb.fileIndex,
    formatCode: isJpg ? 2 : 26,
    thumbType: thumb.thumbType,
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
    {
      appid: thumb.appid,
      field100: 5,
      ...(thumb.filesetRef ? { fileRef: thumb.filesetRef } : {}),
    },
  );

  await postSliceupload(bodyBytes, 'thumbnail sliceupload');
}
