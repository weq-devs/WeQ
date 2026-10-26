import type { FlashDownloadBatch, FlashDownloadTask, FlashTaskStatus } from './types';

/** 只按明确记录的操作 id 归并，不猜测旧任务的创建时间或文件集合。 */
export function groupFlashDownloads(tasks: FlashDownloadTask[]): FlashDownloadBatch[] {
  const groups = new Map<string, FlashDownloadTask[]>();
  for (const task of tasks) {
    const id = task.batchId ?? task.id;
    const files = groups.get(id) ?? [];
    files.push(task);
    groups.set(id, files);
  }
  return [...groups].map(([id, files]) => {
    const first = files[0]!;
    const errors = files.flatMap((file) => [
      ...(file.resolutionErrors ?? []),
      ...(file.error ? [`${file.relativePath}: ${file.error}`] : []),
    ]);
    const status: FlashTaskStatus = files.some((file) => file.status === 'downloading')
      ? 'downloading'
      : files.some((file) => file.status === 'resolving')
        ? 'resolving'
        : files.some((file) => file.status === 'pending')
          ? 'pending'
          : errors.length || files.some((file) => file.status === 'failed')
            ? 'failed'
            : files.some((file) => file.status === 'cancelled')
              ? 'cancelled'
              : 'done';
    const active = ['pending', 'resolving', 'downloading'].includes(status);
    return {
      ...first,
      id,
      name: first.batchId ? first.filesetName : first.name,
      status,
      files,
      fileSize: files.reduce((sum, file) => sum + file.fileSize, 0),
      downloadedBytes: files.reduce((sum, file) => sum + file.downloadedBytes, 0),
      createdAt: Math.min(...files.map((file) => file.createdAt)),
      finishedAt: active ? undefined : Math.max(...files.map((file) => file.finishedAt ?? 0)),
      error: errors.length ? errors.join('\n') : undefined,
    };
  });
}
