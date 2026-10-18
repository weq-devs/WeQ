import { z } from 'zod';
import { sanitizeSegment, type ExportTask } from '@weq/service';

export function exportDownloadName(
  task: Pick<ExportTask, 'id' | 'name' | 'format' | 'bundleDir'>,
): string {
  const extension = task.bundleDir ? 'zip' : task.format === 'vcard' ? 'vcf' : task.format;
  return `${sanitizeSegment(task.name, task.id, { maxLen: 120 })}.${extension}`;
}

export const exportSavePolicyInput = z.object({
  mode: z.enum(['preset', 'before', 'after']),
  directory: z.string().min(1).optional(),
});
