import { z } from 'zod';
import {
  sanitizeSegment,
  type ExportTask,
  type HostBridge,
  type ExportSavePolicy,
} from '@weq/service';

export function exportDownloadName(
  task: Pick<ExportTask, 'id' | 'name' | 'format' | 'bundleDir'>,
): string {
  const extension = task.bundleDir ? 'zip' : task.format === 'vcard' ? 'vcf' : task.format;
  return `${sanitizeSegment(task.name, task.id, { maxLen: 120 })}.${extension}`;
}

export const exportSavePolicyInput = z.object({
  mode: z.enum(['preset', 'before', 'after']),
  directory: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
});

/** 完成后的另存只根据真实产物选择系统文件框或目录框。 */
export async function pickExportOutputDestination(
  task: Pick<ExportTask, 'id' | 'name' | 'format' | 'bundleDir'>,
  host: Pick<HostBridge, 'exportRoot' | 'pickDirectory' | 'pickSaveTarget'>,
): Promise<ExportSavePolicy | null> {
  if (task.bundleDir || host.exportRoot) {
    const directory = await host.pickDirectory({
      title: host.exportRoot ? '选择服务器保存文件夹' : '选择导出保存文件夹',
    });
    return directory ? { mode: 'before', directory } : null;
  }
  const selected = await host.pickSaveTarget({
    defaultName: exportDownloadName(task),
    extension: task.format === 'vcard' ? 'vcf' : task.format,
  });
  return selected ? { mode: 'before', filePath: selected.path } : null;
}
