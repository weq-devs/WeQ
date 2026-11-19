import { transferPercent, type TransferProgress } from '../../../shared/transfer_progress';

export function transferLabel(progress: TransferProgress): string {
  switch (progress.phase) {
    case 'to-host':
      return '正在传给电脑';
    case 'upload':
      return '正在上传';
    case 'download':
      return '正在下载';
    case 'confirming':
      return '正在确认结果';
    case 'failed':
      return '上传失败';
    default:
      return '正在准备';
  }
}

export function transferDetail(progress: TransferProgress): string | undefined {
  const percent = transferPercent(progress);
  if (percent !== undefined) return `${percent}%`;
  if (progress.items) return `已处理 ${progress.processed ?? 0}/${progress.items} 项`;
  if (progress.processed) return `已处理 ${progress.processed} 项`;
  return undefined;
}
