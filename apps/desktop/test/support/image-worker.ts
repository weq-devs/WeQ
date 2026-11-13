import { build } from 'esbuild';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { imageProcessor } from '../../src/main/image_processor';
import * as workerPath from '../../src/main/worker_path';

export async function buildImageWorker(root: string): Promise<string> {
  const path = join(root, 'imageWorker.mjs');
  await symlink(resolve(__dirname, '../../node_modules'), join(root, 'node_modules'), 'dir');
  await build({
    entryPoints: [resolve(__dirname, '../../src/main/image_worker.ts')],
    outfile: path,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  return path;
}

export function setupImageWorker(): void {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'weq-image-worker-'));
    const path = await buildImageWorker(root);
    vi.spyOn(workerPath, 'resolveChildWorkerPath').mockReturnValue(path);
  });
  afterAll(async () => {
    imageProcessor.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
}
