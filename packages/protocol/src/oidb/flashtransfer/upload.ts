// 闪传上传编排:0x93cf 申请 fileset → 0x93d0 commit → 0x93db complete →
// 逐文件 0x12a9 prepare/apply + highway sliceupload → 缩略图 → 0x93d1 状态。
//
// 多文件:0x93d0 的 f4 是 repeated,一个 commit 请求同时携带 fileset 内全部文件条目,
// 每条 f6=文件序号(1,2,3...)。prepare/apply 的 filesetWrap.f4 必须与 commit 的 f6
// 一致,否则文件不计入 fileset。ApplyFileset 的 fileName 是 fileset 显示名(卡片标题)。
//
// 只有 sliceupload 路径会上报主文件 sha1/size,服务端据此把 fileset 标记为完成
// (对端可下载);小文件也统一走 sliceupload,不走小文件 PUT。

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import type { OidbNative } from '../../transport';
import { hashFlashFileStreaming } from '../../highway/hash-file';
import { sliceuploadFile } from '../../highway/sliceupload';
import { ApplyFileset, type ApplyFilesetParams } from './apply-fileset';
import { ApplyUpload } from './apply-upload';
import { CommitFile, type CommitEntry } from './commit-file';
import { CompleteFileset } from './complete-fileset';
import { buildFileId } from './file-id';
import { fileTypeCode } from './file-type';
import { PrepareUpload } from './prepare-upload';
import { SetFilesetStatus } from './set-status';
import { uploadThumbnail } from './thumbnail';

/** 单文件上传上限(与群文件相同,4 GiB)。 */
const MAX_FLASH_BYTES = 4 * 1024 * 1024 * 1024;

/** 一个上传条目:本地路径 + 可选展示名。 */
export interface FlashUploadItem {
  path: string;
  name?: string;
}

export interface FlashUploadOptions {
  /** fileset 标题(卡片名);不传时单文件用文件名,多文件用「<首文件>等N个文件」。 */
  name?: string;
  uploader: ApplyFilesetParams['uploader'];
}

export interface FlashUploadResult {
  filesetUuid: string;
  /** 分享链接 qfile.qq.com/q/<code>(来自 0x93cf 响应)。 */
  shareUrl: string;
}

interface StagedItem {
  path: string;
  fileName: string;
  fileSize: number;
  fileUuid: string;
  fileIndex: number;
  formatCode: number;
}

interface PreparedUpload {
  rkey: string;
  sha1StateV: Uint8Array[];
  sliceCount: number;
}

function displayName(override: string | undefined, fallback: string): string {
  const cleaned = (override ?? '').replace(/[/\\]/g, '_').trim();
  return cleaned || fallback;
}

/** 阶段1:流式哈希 + prepare(拿 rkey)+ apply(注册 fileId)。秒传(rkey=null)返回 null。 */
async function prepareAndApply(
  nt: OidbNative,
  pid: number,
  filesetUuid: string,
  item: StagedItem,
): Promise<PreparedUpload | null> {
  const hashes = await hashFlashFileStreaming(item.path);
  const rkey = await PrepareUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid: item.fileUuid,
    fileName: item.fileName,
    fileSize: item.fileSize,
    sha1: hashes.sha1Hex,
    fileIndex: item.fileIndex,
    formatCode: item.formatCode,
  });
  if (rkey === null) return null; // 秒传

  const fileId = buildFileId(hashes.sha1, item.fileSize);
  await ApplyUpload.invoke(nt, pid, {
    filesetUuid,
    fileUuid: item.fileUuid,
    fileId,
    fileName: item.fileName,
    fileSize: item.fileSize,
    md5: hashes.md5Hex,
    sha1: hashes.sha1Hex,
    fileIndex: item.fileIndex,
    formatCode: item.formatCode,
  });
  return { rkey, sha1StateV: hashes.sha1StateV, sliceCount: hashes.sliceCount };
}

/** 上传一个/多个本地文件到闪传,返回 filesetUuid + 分享链接。 */
export async function uploadFlashFiles(
  nt: OidbNative,
  pid: number,
  files: FlashUploadItem[],
  opts: FlashUploadOptions,
): Promise<FlashUploadResult> {
  if (files.length === 0) throw new Error('upload flash files: files is empty');

  const items: StagedItem[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const stat = await fsp.stat(file.path);
    if (!stat.isFile()) throw new Error(`upload flash files: not a file: ${file.path}`);
    if (stat.size === 0) throw new Error(`upload flash files: file is empty: ${file.path}`);
    if (stat.size > MAX_FLASH_BYTES)
      throw new Error(`upload flash files: file too large: ${file.path}`);
    const fileName = displayName(file.name, basename(file.path));
    const { formatCode } = fileTypeCode(fileName);
    items.push({
      path: file.path,
      fileName,
      fileSize: stat.size,
      fileUuid: randomUUID(),
      fileIndex: i + 1,
      formatCode,
    });
  }

  const first = items[0]!;
  const isMulti = items.length > 1;
  const filesetName =
    opts.name?.trim() || (isMulti ? `${first.fileName}等${items.length}个文件` : first.fileName);
  const totalSize = items.reduce((sum, item) => sum + item.fileSize, 0);
  const { typeCode } = fileTypeCode(first.fileName);

  // 申请 fileset(响应带分享链接)。fileName 是卡片标题,各文件真实名走 commit。
  const apply = await ApplyFileset.invoke(nt, pid, {
    fileName: filesetName,
    origName: filesetName,
    fileSize: totalSize,
    typeCode,
    uploader: opts.uploader,
  });
  const filesetUuid = apply.filesetUuid;

  // 一次性 commit 所有文件元数据(f4 repeated,每条 f6=序号)。
  const entries: CommitEntry[] = items.map((item) => ({
    fileUuid: item.fileUuid,
    fileName: item.fileName,
    origName: item.fileName,
    fileSize: item.fileSize,
    formatCode: item.formatCode,
    fileIndex: item.fileIndex,
  }));
  await CommitFile.invoke(nt, pid, { filesetUuid, entries });
  await CompleteFileset.invoke(nt, pid, { filesetUuid });

  // 两阶段上传:先全部 prepare+apply 注册 fileId,再全部 sliceupload 落盘。
  const prepared: { item: StagedItem; upload: PreparedUpload }[] = [];
  for (const item of items) {
    const upload = await prepareAndApply(nt, pid, filesetUuid, item);
    if (upload) prepared.push({ item, upload });
  }
  for (const { item, upload } of prepared) {
    await sliceuploadFile(
      item.path,
      item.fileSize,
      upload.rkey,
      upload.sha1StateV,
      upload.sliceCount,
      item.fileName,
    );
  }

  // fileset 级缩略图(序号在主文件之后递增),主文件下载入口需要缩略图关联。
  await uploadThumbnail(nt, pid, filesetUuid, first.fileUuid, 'png', items.length + 1);
  await uploadThumbnail(nt, pid, filesetUuid, first.fileUuid, 'jpg', items.length + 2);

  await SetFilesetStatus.invoke(nt, pid, { filesetUuid });
  return { filesetUuid, shareUrl: apply.uploadUrl };
}
