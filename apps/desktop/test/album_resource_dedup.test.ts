import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { deduplicateAlbumResources } from '../src/main/album_resource_dedup';

it('跨相册同内容共用存储，同名不同内容保持独立，取消不破坏文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-album-dedup-'));
  try {
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    const a = join(root, 'a/photo.jpg'),
      b = join(root, 'b/photo.jpg'),
      c = join(root, 'b/other.jpg');
    await writeFile(a, 'same');
    await writeFile(b, 'same');
    await writeFile(c, 'different');
    await deduplicateAlbumResources(root, new AbortController().signal);
    expect((await stat(a)).ino).toBe((await stat(b)).ino);
    expect((await stat(a)).ino).not.toBe((await stat(c)).ino);
    await expect(deduplicateAlbumResources(root, AbortSignal.abort())).rejects.toThrow();
    expect(await readFile(c, 'utf8')).toBe('different');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
