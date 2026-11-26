import type { MonitorPrunePreview } from '@weq/service/performance';
import { historyCapacityLabel } from '@weq/service/settings-catalog';
import { preciseTimeFormatter } from '@weq/time';

export const historySize = (bytes: number) =>
  `${(bytes / 1048576).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} MiB`;

export function performancePruneMessage(preview: MonitorPrunePreview) {
  const lines = [
    `当前性能记录占用 ${historySize(preview.bytes)}，共 ${preview.records.toLocaleString('zh-CN')} 条记录。`,
  ];
  if (preview.expiredRecords > 0 && preview.cutoff !== null)
    lines.push(
      `保存时长改为 ${preview.retentionDays} 天，将删除北京时间 ${preciseTimeFormatter.format(new Date(preview.cutoff))} 之前的 ${preview.expiredRecords.toLocaleString('zh-CN')} 条记录。`,
    );
  if (preview.capacityExceeded && preview.capacityBudgetBytes !== null) {
    lines.push(
      `容量上限设为 ${historyCapacityLabel(preview.capacityMiB)}，为写入预留 10% 空间，实际回收目标为 ${historySize(preview.capacityBudgetBytes)}。`,
    );
    lines.push(
      preview.expiredRecords > 0
        ? '按时间清理后如仍超出目标，将继续从最旧记录开始删除。'
        : '将从最旧记录开始删除，直到占用降至回收目标。',
    );
  }
  return lines.join('\n\n');
}
