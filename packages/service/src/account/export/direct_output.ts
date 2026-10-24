import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { sanitizeSegment } from '../../common/path_sanitize';
import type { ExportSavePolicy } from './save_output';

export interface DirectOutput {
  directory: string;
  filePath?: string;
  journalDirectory: string;
}

/** 创建任务独占的结果位置，不覆盖已有文件，也不在失效目录创建替代位置。 */
export function prepareDirectOutput(
  policy: ExportSavePolicy,
  id: string,
  name: string,
): DirectOutput | undefined {
  if (policy.mode === 'after') return;
  const parent = policy.filePath ? dirname(policy.filePath) : policy.directory;
  if (!parent || !lstatSync(parent).isDirectory()) throw new Error('保存目录不可用，请重新选择。');
  const root = realpathSync(parent);
  if (policy.filePath) {
    const selected = basename(policy.filePath);
    for (let n = 0; ; n++) {
      const ext = extname(selected);
      const filePath = join(root, n ? `${basename(selected, ext)} (${n})${ext}` : selected);
      if (existsSync(`${filePath}.report.json`) || existsSync(`${filePath}.report.html`)) {
        if (policy.uniqueFileName) continue;
        throw new Error('保存位置已有同名报告。');
      }
      try {
        closeSync(openSync(filePath, 'wx'));
      } catch (error) {
        if (policy.uniqueFileName && (error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const journalDirectory = join(root, `.weq-export-${id}`);
      mkdirSync(journalDirectory);
      return { directory: root, filePath, journalDirectory };
    }
  }
  const directory = join(root, `${sanitizeSegment(name, 'export')}-${id}`);
  mkdirSync(directory);
  const journalDirectory = join(directory, '.weq-export');
  mkdirSync(journalDirectory);
  return { directory, journalDirectory };
}
