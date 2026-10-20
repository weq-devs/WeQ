import { z } from 'zod';
import {
  sanitizeSegment,
  type ExportTask,
  type HostBridge,
  type ExportSavePolicy,
  EXPORT_EXTENSION_PATTERN,
  type ExportOutputShape,
  exportOutputFileName,
} from '@weq/service';
import { dirname, join } from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import {
  copyExportSavePolicy,
  resolveExportSaveDirectory,
  resolveExportSaveFile,
} from '@weq/service';

export function exportDownloadName(
  task: Pick<ExportTask, 'id' | 'name' | 'format' | 'bundleDir' | 'resource'>,
): string {
  const extension = task.bundleDir
    ? 'zip'
    : (task.resource?.output?.extension ?? (task.format === 'vcard' ? 'vcf' : task.format));
  return `${sanitizeSegment(task.name, task.id, { maxLen: 120 })}.${extension}`;
}

export const exportSavePolicyInput = z.object({
  mode: z.enum(['preset', 'before', 'after']),
  directory: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  uniqueFileName: z.boolean().optional(),
});

const outputFormat = z.string().regex(EXPORT_EXTENSION_PATTERN);
export const exportOutputPlanInput = z.object({
  kind: z.enum(['messages', 'contacts', 'bundle', 'file']),
  name: z.string().min(1),
  format: outputFormat.optional(),
  formats: z.array(outputFormat).min(1).optional(),
  targetCount: z.number().int().positive().safe().optional(),
  contactScope: z.enum(['friends', 'group', 'groups']).optional(),
  exportAvatar: z.boolean().optional(),
  media: z
    .object({
      exportMedia: z.boolean().optional(),
      transcribeVoice: z.boolean().optional(),
      ocrImages: z.boolean().optional(),
      mediaKinds: z.object({ sysface: z.boolean().optional() }).optional(),
    })
    .optional(),
  dress: z
    .object({
      bubble: z.boolean().optional(),
      font: z.boolean().optional(),
      widget: z.boolean().optional(),
    })
    .optional(),
});

/** 已选位置优先；只有确实需要询问时才调用宿主选择器，不改变长期偏好。 */
export async function prepareExportDestination(
  input: ExportSavePolicy,
  defaultDirectory: string | null | undefined,
  host: Pick<HostBridge, 'exportRoot' | 'pickDirectory' | 'pickSaveTarget'>,
  output?: ExportOutputShape,
  current: () => void = () => {},
): Promise<ExportSavePolicy | null> {
  current();
  if (input.mode === 'after') return { mode: 'after' };
  if (input.directory && input.filePath) throw new Error('保存位置只能选择文件或目录之一。');
  if (input.uniqueFileName && !input.filePath && output?.kind !== 'file')
    throw new Error('自动文件命名仅支持单文件位置。');
  let mode = input.mode;
  let filePath = input.filePath;
  let directory = input.directory ?? (mode === 'preset' ? defaultDirectory : undefined);
  let uniqueFileName = input.uniqueFileName;
  if (filePath && output?.kind === 'directory')
    throw new Error('结果包含多个文件，请选择保存文件夹。');
  if (!filePath && !directory && !host.exportRoot) {
    mode = 'before';
    if (output?.kind === 'file') {
      const selected = await host.pickSaveTarget({
        defaultName: exportOutputFileName(output),
        extension: output.extension,
      });
      if (!selected) return null;
      filePath = selected.path;
    } else {
      directory = await host.pickDirectory({ title: '选择本次导出保存位置' });
      if (!directory) return null;
    }
  }
  current();
  if (!filePath) {
    directory = host.exportRoot
      ? resolveExportSaveDirectory(host.exportRoot, directory ?? '')
      : directory;
    if (!directory) throw new Error('保存目录不可用，请重新选择。');
    if (host.exportRoot) await mkdir(directory, { recursive: true });
    if (!(await lstat(directory).catch(() => null))?.isDirectory())
      throw new Error('保存目录不可用，请重新选择。');
    if (output?.kind === 'file') {
      filePath = join(directory, exportOutputFileName(output));
      directory = undefined;
      uniqueFileName = true;
    }
  } else {
    filePath = host.exportRoot
      ? resolveExportSaveFile(host.exportRoot, filePath, uniqueFileName)
      : filePath;
    const validated = copyExportSavePolicy({ mode, filePath, uniqueFileName });
    filePath = validated.filePath!;
    if (host.exportRoot) await mkdir(dirname(filePath), { recursive: true });
    if (!(await lstat(dirname(filePath)).catch(() => null))?.isDirectory())
      throw new Error('保存目录不可用，请重新选择。');
  }
  current();
  return copyExportSavePolicy({
    mode,
    ...(filePath ? { filePath, uniqueFileName } : { directory: directory ?? undefined }),
  });
}

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
  task: Pick<ExportTask, 'id' | 'name' | 'format' | 'bundleDir' | 'resource'>,
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
    extension: task.resource?.output?.extension ?? (task.format === 'vcard' ? 'vcf' : task.format),
  });
  return selected ? { mode: 'before', filePath: selected.path } : null;
}
