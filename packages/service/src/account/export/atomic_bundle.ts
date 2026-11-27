import { assertQqFileWriteAllowed } from '@weq/db';
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
export function createAtomicExportBundle(
  root: string,
  id: string,
  resumable = false,
): AtomicExportBundle {
  assertQqFileWriteAllowed(root);
  mkdirSync(root, { recursive: true });
  const finalDir = join(root, `bundle-${id}`);
  const stageDir = join(
    root,
    resumable ? `.bundle-${id}.partial` : `.bundle-${id}-${randomUUID()}.partial`,
  );
  assertQqFileWriteAllowed([stageDir, finalDir]);
  mkdirSync(stageDir, { recursive: resumable, mode: 0o700 });
  let published = false;
  return {
    stageDir,
    finalDir,
    publish(): void {
      if (published) return;
      if (existsSync(finalDir)) throw new Error(`导出目标已存在：${finalDir}`);
      assertQqFileWriteAllowed([
        { path: stageDir, tree: true },
        { path: finalDir, tree: true },
      ]);
      renameSync(stageDir, finalDir);
      published = true;
    },
    discard(): void {
      if (published) return;
      assertQqFileWriteAllowed({ path: stageDir, tree: true });
      rmSync(stageDir, { recursive: true, force: true });
    },
  };
}
