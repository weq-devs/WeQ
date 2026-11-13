import { link, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileDigest } from '@weq/service';

/** 保留每项媒体的目录位置，同内容文件在资源包内共用存储。 */
export async function deduplicateAlbumResources(directory: string, signal: AbortSignal) {
  const hashes = new Map<string, string>();
  async function visit(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      signal.throwIfAborted();
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const { sha256 } = await fileDigest(path, signal);
      signal.throwIfAborted();
      const first = hashes.get(sha256);
      if (!first) {
        hashes.set(sha256, path);
        continue;
      }
      const temp = `${path}.${randomUUID()}.dedup`;
      try {
        await link(first, temp);
        signal.throwIfAborted();
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    }
  }
  await visit(directory);
}
