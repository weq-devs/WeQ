/**
 * 闪传下载解析器 —— 移植自 OpenList-QQ-Flash 的 resolver.go，修了两处：
 *
 *   1. 不再在解析阶段并发换下载直链（OpenList 的 addDownloadTask 会为每个文件
 *      先打一次 BatchDownload）；这里只枚举出「要下载哪些文件」，直链放到下载
 *      阶段逐个换，避免几十个文件挤在解析期。
 *   2. 压缩包内的目录现在能正确走 GetCompressedFileFolder（OpenList 的
 *      UserSelection.IsZipContent / ZipFileID 前端从没传过，这条分支是坏的）。
 *
 * 目录递归是顺序的（每层依赖父层列表），顶层多个选择之间并发。
 */
import type { FlashTransferClient } from './client';
import type { FlashDownloadFile, FlashSelection } from './types';

/** 压缩包 / 压缩包内目录递归时用到的「根压缩包 cliFileId」。 */

export class FlashTransferResolver {
  constructor(
    private readonly client: FlashTransferClient,
    private readonly concurrency = 3,
  ) {}

  /** 把用户勾选的条目（文件 / 目录 / 压缩包内部条目）展开成待下载文件清单。 */
  async resolveDownloads(
    selections: FlashSelection[],
  ): Promise<{ files: FlashDownloadFile[]; errors: string[] }> {
    const files: FlashDownloadFile[] = [];
    const errors: string[] = [];
    const rootPath = findCommonPrefix(selections.map((s) => s.path));
    const rootTrimmed = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;

    // 顶层选择之间小并发（每个选择内部顺序递归）；结果按选择顺序收集，保持稳定。
    const queue = [...selections];
    const perIndex: FlashDownloadFile[][] = new Array(queue.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= queue.length) return;
        const item = queue[index]!;
        const relPath = stripPrefix(item.path, rootTrimmed);
        const local: FlashDownloadFile[] = [];
        try {
          await this.processItem(item, relPath, local, errors);
        } catch (error) {
          errors.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        perIndex[index] = local;
      }
    });
    await Promise.all(workers);
    for (const group of perIndex) files.push(...(group ?? []));
    return { files, errors };
  }

  private async processItem(
    item: FlashSelection,
    relPath: string,
    files: FlashDownloadFile[],
    errors: string[],
  ): Promise<void> {
    if (item.isDir) {
      await this.walkFolder(
        item.filesetId,
        item.fileId,
        relPath,
        item.isZipContent,
        item.zipFileId,
        files,
        errors,
      );
      return;
    }
    if (!item.physicalId) {
      errors.push(`${item.path}: 缺少物理 ID，无法下载`);
      return;
    }
    // relPath 已包含文件名本身（选中条目的 path 就是完整路径），直接用它。
    files.push({
      name: item.name,
      physicalId: item.physicalId,
      relativePath: relPath || item.name,
      fileSize: item.fileSize,
      filesetId: item.filesetId,
    });
  }

  private async walkFolder(
    filesetId: string,
    parentId: string,
    relDir: string,
    isInsideZip: boolean,
    rootZipId: string,
    files: FlashDownloadFile[],
    errors: string[],
  ): Promise<void> {
    const nodes = isInsideZip
      ? await this.client.listCompressedFiles(filesetId, rootZipId, parentId)
      : await this.client.listFiles(filesetId, parentId);

    for (const node of nodes) {
      const childRelPath = joinRel(relDir, node.name);
      if (node.isDir) {
        // 压缩包内子目录继续用压缩包接口；普通目录用普通接口。
        await this.walkFolder(
          filesetId,
          node.fileId,
          childRelPath,
          isInsideZip,
          rootZipId,
          files,
          errors,
        );
      } else {
        if (!node.physicalId) {
          errors.push(`${childRelPath}: 缺少物理 ID，无法下载`);
          continue;
        }
        files.push({
          name: node.name,
          physicalId: node.physicalId,
          relativePath: childRelPath,
          fileSize: node.fileSize,
          filesetId: node.filesetId || filesetId,
        });
      }
    }
  }

  /** 递归枚举整个 fileset（tree 工具，未选文件时方便“全量下载”规划）。 */
  async treeFileset(filesetId: string): Promise<FlashDownloadFile[]> {
    const files: FlashDownloadFile[] = [];
    const errors: string[] = [];
    await this.walkFolder(filesetId, '', '', false, '', files, errors);
    return files;
  }
}

// ---- 路径工具 ------------------------------------------------------------

function stripPrefix(value: string, prefix: string): string {
  let rel = value;
  if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  rel = rel.replace(/^\/+/, '');
  return rel;
}

/** 求多个路径的公共前缀（按 '/' 切到完整段，移植自 OpenList）。 */
function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) {
    const last = paths[0]!.lastIndexOf('/');
    const dir = last >= 0 ? paths[0]!.slice(0, last) : '';
    return dir.length > 0 ? `${dir}/` : '';
  }
  const sorted = [...paths].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let i = 0;
  while (i < first.length && i < last.length && first[i] === last[i]) i += 1;
  const common = first.slice(0, i);
  const idx = common.lastIndexOf('/');
  return idx >= 0 ? common.slice(0, idx + 1) : '';
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
