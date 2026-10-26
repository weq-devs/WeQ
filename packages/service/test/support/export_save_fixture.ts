import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaDeps } from '../../src/account/export/task_manager';

/** 非保存专项测试也显式准备位置，所有产物随各自临时夹具一起清理。 */
export function withExportSaveDirectory(cache: string, deps: MediaDeps = {}): MediaDeps {
  const directory = join(cache, 'selected-output');
  mkdirSync(directory, { recursive: true });
  return { exportSavePolicy: () => ({ mode: 'before', directory }), ...deps };
}
