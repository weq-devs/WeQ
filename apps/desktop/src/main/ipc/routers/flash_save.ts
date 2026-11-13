import type { HostBridge, FlashTransferDownloadManager, FlashSelection } from '@weq/service';
import { prepareExportDestination } from './export_save';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';

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
    path = dirname(path);
    for (const item of task.files) {
      while (true) {
        const rel = relative(path, dirname(item.targetPath));
        if (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
          break;
        const parent = dirname(path);
        if (parent === path) throw new Error('下载文件不在同一目录中。');
        path = parent;
      }
    }
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

/** 目录选择取消时不解析目录、不创建任务；宿主负责分别记忆闪传的保存位置。 */
export async function startFlashDownloads(
  input: { filesetName: string; selections: FlashSelection[]; directory?: string },
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
    )),
    cancelled: false,
  };
}
