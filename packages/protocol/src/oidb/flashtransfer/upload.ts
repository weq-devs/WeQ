// 闪传上传编排:0x93cf 申请 fileset → 0x93d0 commit → 0x93db complete →
// 缩略图 prepare/apply/sliceupload → 逐文件 0x12a9 prepare/apply + highway
// sliceupload → 0x93d1 状态。
//
// 多文件:0x93d0 的 f4 是 repeated,一个 commit 请求同时携带 fileset 内全部文件条目,
// 每条 f6=文件序号(1,2,3...)。prepare/apply 的 filesetWrap.f4 必须与 commit 的 f6
// 一致,否则文件不计入 fileset。ApplyFileset 的 fileName 是 fileset 显示名(卡片标题)。
//
// 只有 sliceupload 路径会上报主文件 sha1/size,服务端据此把 fileset 标记为完成
// (对端可下载);小文件也统一走 sliceupload,不走小文件 PUT。
//
// 编排拆成几段,方便「先把消息发出去、上传全放后台」的调用方:
//   createFlashFileset    —— 校验 + 申请 fileset(发起),返回 pending;
//   commitFlashFileset    —— commit → complete(只登记元数据,不传文件);
//   uploadFlashThumbnail  —— 缩略图 prepare/apply/sliceupload(封面就绪);
//   stageFlashFileset     —— commit + 缩略图(需要「发送前封面就绪」时用);
//   uploadFlashMainFiles  —— 主文件并行 100(prepare)/103(apply)→ 并行分片上传
//                            → 0x93d1 状态;
//   finishFlashUpload     —— stage + uploadFlashMainFiles 连续执行;
//   uploadFlashFiles      —— create + finish 连续执行(等价于旧行为)。
//
// 「封面传完才发、主文件后台传」的推荐时序(见 FlashTransferService.sendFlashTransfer):
//   create → **stage(commit + 封面)** → 0x93d7 发消息 → 后台(主文件)。
// commit/complete 与**封面字节**都必须排在 0x93d7 之前:前者让对端点开就有文件清单,
// 后者让卡片一到就有封面 —— 实机抓包(2026-10-10)里 QQ 就是传完封面+主文件才发消息,
// 封面晚于发送会让对端回退默认封面(客户端不会再重拉 fileset)。只有主文件的大字节
// 挪到消息发出之后在后台跑。

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import type { OidbNative } from '../../transport';
import { hashFlashFileStreaming } from '../../highway/hash-file';
import { sliceuploadFile } from '../../highway/sliceupload';
import {
  ApplyFileset,
  FLASH_UPLOAD_SCENE_AIO_FILE_SELECTOR,
  type ApplyFilesetParams,
} from './apply-fileset';
import { ApplyUpload } from './apply-upload';
import { CommitFile, type CommitEntry } from './commit-file';
import { CompleteFileset } from './complete-fileset';
import { buildFileId, FLASH_APPID_MAIN } from './file-id';
import { fileTypeCode } from './file-type';
import { PrepareUpload } from './prepare-upload';
import { SetFilesetStatus } from './set-status';
import { applyThumbnail, prepareThumbnail, sliceuploadThumbnail } from './thumbnail';

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
  /** 可选的真实 PNG 缩略图路径;不传则不传缩略图(不再上传默认占位图)。 */
  thumbPath?: string;
  /** 文件集有效期(秒)。缺省 1209600(14 天);可选 90/180 天。 */
  validitySeconds?: number;
  uploader: ApplyFilesetParams['uploader'];
}

export interface FlashUploadResult {
  filesetUuid: string;
  /** 分享链接 qfile.qq.com/q/<code>(来自 0x93cf 响应)。 */
  shareUrl: string;
}

/** 已建档、等待后台完成上传的 fileset(createFlashFileset 的产物)。 */
export interface FlashFilesetPending {
  filesetUuid: string;
  shareUrl: string;
  thumbPath?: string;
  items: FlashStagedItem[];
}

/** 一个待上传文件的固定元数据(commit/prepare/apply 共用)。 */
export interface FlashStagedItem {
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
  /** apply 响应里规范化后的 filesetWrap 原始字节（sliceupload f107.f101 原样回带）。 */
  filesetRef: Uint8Array | null;
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
  item: FlashStagedItem,
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
  const fileId = buildFileId(hashes.sha1, item.fileSize);
  const filesetRef = await ApplyUpload.invoke(nt, pid, {
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

  // 秒传只跳过实际 sliceupload；当前 fileset 仍必须完成 ApplyUpload 绑定。
  if (rkey === null) return null;
  return { rkey, sha1StateV: hashes.sha1StateV, sliceCount: hashes.sliceCount, filesetRef };
}

/** 阶段A:校验本地文件并申请 fileset(发起)。返回 pending,后续走 finishFlashUpload。 */
export async function createFlashFileset(
  nt: OidbNative,
  pid: number,
  files: FlashUploadItem[],
  opts: FlashUploadOptions,
): Promise<FlashFilesetPending> {
  if (files.length === 0) throw new Error('upload flash files: files is empty');

  const items: FlashStagedItem[] = [];
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

  // 申请 fileset(响应带分享链接)。fileName 是卡片标题,各文件真实名走 commit。
  const apply = await ApplyFileset.invoke(nt, pid, {
    fileName: filesetName,
    origName: filesetName,
    fileSize: totalSize,
    uploadSceneType: FLASH_UPLOAD_SCENE_AIO_FILE_SELECTOR,
    ...(opts.validitySeconds !== undefined ? { validitySeconds: opts.validitySeconds } : {}),
    uploader: opts.uploader,
  });

  return {
    filesetUuid: apply.filesetUuid,
    shareUrl: apply.uploadUrl,
    thumbPath: opts.thumbPath,
    items,
  };
}

/** 阶段B0:commit → complete(只登记文件元数据,不传任何字节)。
 *
 * 0x93d7 之前跑完这一步,对端点开文件集就能看到文件清单(大小 / 名字 / 序号);
 * 字节上传留到后面。 */
export async function commitFlashFileset(
  nt: OidbNative,
  pid: number,
  pending: FlashFilesetPending,
): Promise<void> {
  const { filesetUuid, items } = pending;

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
}

/** 阶段B1:缩略图完整上传:prepare → apply → sliceupload(让卡片封面就绪)。
 *
 * 必须在 0x93d7 发消息**之前**跑完 —— 对端一收到消息就拉 fileset,封面没登记就只显示
 * 默认封面且不会重拉(见模块头注释)。由 `stageFlashFileset` 在发送前调用。 */
export async function uploadFlashThumbnail(
  nt: OidbNative,
  pid: number,
  pending: FlashFilesetPending,
): Promise<void> {
  if (pending.thumbPath === undefined) return;
  const thumb = await prepareThumbnail(
    nt,
    pid,
    pending.filesetUuid,
    pending.thumbPath,
    pending.items.length + 1,
  );
  await applyThumbnail(thumb);
  await sliceuploadThumbnail(thumb);
}

/** 阶段B1':commit → complete → 缩略图上传(**发消息前的标准时序**:清单先登记、封面先就绪)。 */
export async function stageFlashFileset(
  nt: OidbNative,
  pid: number,
  pending: FlashFilesetPending,
): Promise<void> {
  await commitFlashFileset(nt, pid, pending);
  await uploadFlashThumbnail(nt, pid, pending);
}

/** 阶段B2:主文件 prepare/apply + 并行分片上传 → 0x93d1 状态。 */
export async function uploadFlashMainFiles(
  nt: OidbNative,
  pid: number,
  pending: FlashFilesetPending,
): Promise<void> {
  const { filesetUuid, items } = pending;

  // 所有文件并行:先全部 prepare+apply(100→103)注册 fileId,再并行 sliceupload 落盘。
  const results = await Promise.all(
    items.map(async (item) => ({
      item,
      upload: await prepareAndApply(nt, pid, filesetUuid, item),
    })),
  );
  const prepared = results.filter(
    (r): r is { item: FlashStagedItem; upload: PreparedUpload } => r.upload !== null,
  );
  await Promise.all(
    prepared.map(({ item, upload }) =>
      sliceuploadFile(
        item.path,
        item.fileSize,
        upload.rkey,
        upload.sha1StateV,
        upload.sliceCount,
        item.fileName,
        {
          appid: FLASH_APPID_MAIN,
          field100: 5,
          ...(upload.filesetRef ? { fileRef: upload.filesetRef } : {}),
        },
      ),
    ),
  );

  await SetFilesetStatus.invoke(nt, pid, { filesetUuid });
}

/** 阶段B:stage + 主文件连续执行(等价于旧行为)。 */
export async function finishFlashUpload(
  nt: OidbNative,
  pid: number,
  pending: FlashFilesetPending,
): Promise<void> {
  await stageFlashFileset(nt, pid, pending);
  await uploadFlashMainFiles(nt, pid, pending);
}

/** 完整上传一个/多个本地文件到闪传,返回 filesetUuid + 分享链接。 */
export async function uploadFlashFiles(
  nt: OidbNative,
  pid: number,
  files: FlashUploadItem[],
  opts: FlashUploadOptions,
): Promise<FlashUploadResult> {
  const pending = await createFlashFileset(nt, pid, files, opts);
  await finishFlashUpload(nt, pid, pending);
  return { filesetUuid: pending.filesetUuid, shareUrl: pending.shareUrl };
}
