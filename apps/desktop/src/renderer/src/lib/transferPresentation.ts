import { transferPercent, type TransferProgress } from '../../../shared/transfer_progress';
import { formatSize } from './groupFile';
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
    case 'checking-output':
      return '正在检查导出文件';
    case 'copying-output':
      return '正在复制到保存位置';
    case 'verifying-output':
      return '正在校验保存结果';
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

export function exportTransferReadout(progress: TransferProgress) {
  const { received, total, processed, items, itemTransfer, phase } = progress;
  const saving =
    phase === 'checking-output' || phase === 'copying-output' || phase === 'verifying-output';
  const byteDetail =
    received !== undefined && (received > 0 || total)
      ? `${itemTransfer ? '正在传输 ' : ''}${formatSize(received)}${total ? ` / ${formatSize(total)}` : ''}`
      : undefined;
  const itemDetail = items
    ? `已处理 ${processed ?? 0}/${items} 项`
    : processed
      ? `已处理 ${processed} 项`
      : undefined;
  const itemPercent =
    items && items > 1 && processed !== undefined
      ? Math.min(99, Math.floor((processed / items) * 100))
      : undefined;
  const percent = saving
    ? total && received !== undefined
      ? Math.min(99, Math.floor((received / total) * 100))
      : itemPercent
    : itemTransfer
      ? itemPercent
      : (transferPercent(progress) ?? itemPercent);
  return {
    label: transferLabel(progress),
    percent,
    detail: [itemDetail, byteDetail].filter(Boolean).join(' · '),
  };
}
