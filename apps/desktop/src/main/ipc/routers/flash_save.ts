import type { HostBridge, FlashTransferDownloadManager, FlashSelection } from '@weq/service';
import { prepareExportDestination } from './export_save';

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
