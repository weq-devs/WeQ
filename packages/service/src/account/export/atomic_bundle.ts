import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicExportBundle {
  readonly stageDir: string;
  readonly finalDir: string;
  publish(): void;
  discard(): void;
}

/** Build a complete directory privately, then expose it with one same-volume rename. */
export function createAtomicExportBundle(root: string, id: string): AtomicExportBundle {
  mkdirSync(root, { recursive: true });
  const finalDir = join(root, `bundle-${id}`);
  const stageDir = join(root, `.bundle-${id}-${randomUUID()}.partial`);
  mkdirSync(stageDir, { recursive: false, mode: 0o700 });
  let published = false;
  return {
    stageDir,
    finalDir,
    publish(): void {
      if (published) return;
      if (existsSync(finalDir)) throw new Error(`导出目标已存在：${finalDir}`);
      renameSync(stageDir, finalDir);
      published = true;
    },
    discard(): void {
      if (!published) rmSync(stageDir, { recursive: true, force: true });
    },
  };
}
