import {
  type HostBridge,
  type FlashTransferDownloadManager,
  type FlashSelection,
  sanitizeSegment,
} from '@weq/service';
import { prepareExportDestination } from './export_save';
import { lstat, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';

/** 打开对象仅从当前账号的任务记录解析，异步检查后再次确认账号。 */
export async function openFlashDownloadOutput(
  input: { taskId: string; mode: 'file' | 'directory' | 'reveal' },
  manager: Pick<FlashTransferDownloadManager, 'list'>,
  host: Pick<HostBridge, 'canReveal' | 'revealPath' | 'revealInFolder'>,
  current: () => void,
) {
  current();
  if (!host.canReveal) throw new Error('服务器下载文件不能在当前浏览器中打开。');
  const task = manager.list().find((item) => item.id === input.taskId);
  if (!task?.files.length) throw new Error('下载记录不存在');
  const file = task.files[0]!;
  if (input.mode === 'file' && (task.files.length !== 1 || file.status !== 'done'))
    throw new Error('仅支持打开已完成的单文件下载。');
  let path = file.targetPath;
  if (input.mode === 'directory') {
    path = flashOutputDirectory(task.files.map((item) => item.targetPath));
  }
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info || (input.mode === 'directory' ? !info.isDirectory() : !info.isFile()))
    throw new Error('下载文件或目录已移动或删除，请检查保存位置。');
  current();
  if (input.mode === 'reveal') await host.revealInFolder(path);
  else await host.revealPath(path);
  return { ok: true };
}

function flashOutputDirectory(paths: readonly string[]): string {
  let directory = dirname(paths[0]!);
  for (const path of paths) {
    for (;;) {
      const rel = relative(directory, dirname(path));
      if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) break;
      const parent = dirname(directory);
      if (parent === directory) throw new Error('下载文件不在同一目录中。');
      directory = parent;
    }
  }
  return directory;
}

/** 浏览器只取这批已完成的成品，批量下载不扫描宿主目录。 */
export async function registerFlashDownloadOutput(
  input: { taskId: string; fileId?: string },
  manager: Pick<FlashTransferDownloadManager, 'list' | 'load'>,
  host: Pick<HostBridge, 'registerDownload' | 'registerArchiveDownload'>,
  current: () => void,
) {
  current();
  if (!host.registerDownload) throw new Error('当前环境不支持浏览器下载。');
  await manager.load();
  current();
  const task = manager.list(undefined, false).find((item) => item.id === input.taskId);
  const completed = task?.files.filter(
    (file) => file.status === 'done' && (!input.fileId || file.id === input.fileId),
  );
  if (!completed?.length) throw new Error('没有可取回的已完成文件。');
  for (const file of completed) {
    const info = await lstat(file.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info?.isFile()) throw new Error('下载文件已移动或删除，请检查保存位置。');
  }
  current();
  if (completed.length === 1) {
    const path = completed[0]!.targetPath;
    return host.registerDownload(path, basename(path), 'file');
  }

  if (!host.registerArchiveDownload) throw new Error('当前环境不支持批量浏览器下载。');
  const directory = flashOutputDirectory(completed.map((file) => file.targetPath));
  return host.registerArchiveDownload(
    completed.map(({ targetPath }) => ({
      path: targetPath,
      name: relative(directory, targetPath).split(sep).join('/'),
    })),
    `${sanitizeSegment(task?.filesetName ?? '', '闪传下载')}.zip`,
  );
}

/** 目录选择取消时不解析目录、不创建任务；宿主负责分别记忆闪传的保存位置。 */
export async function startFlashDownloads(
  input: {
    filesetName: string;
    selections: FlashSelection[];
    directory?: string;
    viewFilesetId?: string;
  },
  manager: Pick<FlashTransferDownloadManager, 'start'>,
  host: Pick<HostBridge, 'exportRoot' | 'pickDirectory' | 'pickSaveTarget'>,
  current: () => void,
) {
  const destination = await prepareExportDestination(
    { mode: 'before', directory: input.directory },
    null,
    host,
    { kind: 'directory' },
    current,
    'flash-downloads',
    '选择闪传下载保存位置',
  );
  if (!destination?.directory) return { started: 0, errors: [], cancelled: true };
  return {
    ...(await manager.start(
      input.filesetName,
      input.selections[0]!.filesetId,
      input.selections,
      destination.directory,
      ...(input.viewFilesetId ? [input.viewFilesetId] : []),
    )),
    cancelled: false,
  };
}
