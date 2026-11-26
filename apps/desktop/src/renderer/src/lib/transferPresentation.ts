import { transferPercent, type TransferProgress } from '../../../shared/transfer_progress';
import { IS_WEB } from './target.shared';

export function outgoingTransferProgress(progress: TransferProgress | undefined, toHost?: boolean) {
  if (progress?.phase === 'to-host' && (!IS_WEB || !toHost)) return undefined;
  return progress ?? (IS_WEB && toHost ? { phase: 'to-host' as const } : undefined);
}

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
