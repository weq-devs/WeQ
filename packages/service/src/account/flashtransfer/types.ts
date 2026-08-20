/**
 * QQ 闪传（fileset）浏览 / 下载的类型定义。
 *
 * 数据源是 qfile.qq.com 的匿名 HTTP2RPC 接口（OpenList-QQ-Flash 的
 * flash_transfer 移植），不需要 QQ 在线。分享链接仍走 OIDB（见
 * account/flash_transfer.ts），下载链路完全走 HTTP2RPC。
 */

/** 列表接口返回的单个文件 / 目录条目（已从原始响应拍平）。 */
export interface FlashListFile {
  name: string;
  isDir: boolean;
  /** 原始文件字节数。 */
  fileSize: number;
  /** fileset 内 id：普通条目用 srv_fileid，压缩包内条目回退 cli_fileid。 */
  fileId: string;
  parentId: string;
  filesetId: string;
  /** 换取下载直链的物理 id（physical.id），空表示还不能下载。 */
  physicalId: string;
  /** 压缩包内条目的 cli_fileid（普通条目为空）。 */
  cliFileId: string;
  /** physical.status：2=上传完成可下载。 */
  status: number;
  fileSha1?: string;
}

export interface FlashListResult {
  filesetId: string;
  filesetName?: string;
  /** true 表示这份列表来自压缩包内部。 */
  isZip: boolean;
  files: FlashListFile[];
}

/** 用户勾选的一个条目，交给下载解析器展开成具体文件。 */
export interface FlashSelection {
  filesetId: string;
  /** srv_fileid || id || cli_fileid（前端浏览时确定）。 */
  fileId: string;
  physicalId: string;
  name: string;
  fileSize: number;
  /** 相对 fileset 根的虚拟路径，下载时用来重建目录结构。 */
  path: string;
  isDir: boolean;
  /** 是否压缩包内部条目（是则目录列表走 GetCompressedFileFolder）。 */
  isZipContent: boolean;
  /** 所在压缩包的 cli_fileid（压缩包内部条目才有）。 */
  zipFileId: string;
}

/** 解析完成后待下载的一个文件。 */
export interface FlashDownloadFile {
  name: string;
  physicalId: string;
  /** 相对下载根目录的路径（斜杠分隔，含层级）。 */
  relativePath: string;
  fileSize: number;
  filesetId: string;
}

export type FlashTaskStatus =
  | 'pending'
  | 'resolving'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface FlashDownloadTask {
  id: string;
  filesetId: string;
  filesetName: string;
  name: string;
  physicalId: string;
  /** 相对下载根目录的路径。 */
  relativePath: string;
  /** 落盘绝对路径。 */
  targetPath: string;
  fileSize: number;
  status: FlashTaskStatus;
  downloadedBytes: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}
