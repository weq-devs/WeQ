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

export const exportAccountBindingInput = z.object({
  expectedAccountUin: z.string().min(1).optional(),
  expectedAccountConfigId: z.string().min(1).optional(),
});
export type ExportAccountBinding = z.infer<typeof exportAccountBindingInput>;

/** 等待系统选择器期间允许取消，但不能将旧来源的选择用于另一个账号实例。 */
export function bindExportSaveRequest(
  expected: ExportAccountBinding,
  read: () => { uin?: string; configId?: string; services?: object | null },
): () => void {
  if (!expected.expectedAccountUin && !expected.expectedAccountConfigId) return () => {};
  const initial = read();
  const check = () => {
    const current = read();
    if (
      !current.services ||
      current.services !== initial.services ||
      (expected.expectedAccountUin && current.uin !== expected.expectedAccountUin) ||
      (expected.expectedAccountConfigId && current.configId !== expected.expectedAccountConfigId)
    )
      throw new Error('账号或数据源已切换，请重新选择保存位置。');
  };
  check();
  return check;
}

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
