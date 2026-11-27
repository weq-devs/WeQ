// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AlbumVideoStaging } from '../src/main/ipc/routers/album_video_staging';

describe('Web 视频流式暂存', () => {
  it('重启后按已提交偏移复核前缀，交给写操作的句柄不能再次恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-transfer-checkpoint-'));
    const create = () =>
      new AlbumVideoStaging(60000, {
        label: '附件',
        minBytes: 1,
        maxBytes: 16,
        fileName: 'attachment',
        prefix: 'weq-fixture-',
        persistence: { root: () => root, ownerKey: (owner) => (owner as { key: string }).key },
      });
    const first = create();
    const original = { key: 'original-account' };
    const prefix = Buffer.of(1, 2, 3);
    try {
      const { id } = await first.start(original, 5, 'upload.json');
      await first.append(original, id, 0, prefix);
      const restarted = create();
      await expect(restarted.resume({ key: 'other-account' }, id)).rejects.toThrow('失效');
      const owner = { ...original };
      await expect(restarted.resume(owner, id)).resolves.toEqual({
        id,
        offset: 3,
        size: 5,
        prefixHash: createHash('sha256').update(prefix).digest('hex'),
      });
      await restarted.append(owner, id, 3, Buffer.of(4, 5));
      const path = await restarted.consume(owner, id);
      expect(await readFile(path)).toEqual(Buffer.of(1, 2, 3, 4, 5));
      await expect(create().resume(owner, id)).rejects.toThrow('失效');
      await restarted.discard(owner, id, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('并发创建也遵守数量和总容量上限，删除时撤销附件信任', async () => {
    const store = new AlbumVideoStaging(60000, {
      label: '附件',
      minBytes: 1,
      maxBytes: 10,
      fileName: 'file.txt',
      prefix: 'weq-fixture-',
      maxUploads: 1,
      maxTotalBytes: 3,
    });
    const owner = {};
    const results = await Promise.allSettled([store.start(owner, 3), store.start(owner, 3)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const accepted = results.find((result) => result.status === 'fulfilled');
    if (accepted?.status !== 'fulfilled') throw new Error('暂存未创建');
    let revoked = false;
    store.whenDiscarded(owner, accepted.value.id, () => {
      revoked = true;
    });
    await store.discard(owner, accepted.value.id);
    expect(revoked).toBe(true);
    await expect(store.start(owner, 4)).rejects.toThrow('总量');
  });
  it('草稿附件保留原文件名，拒绝路径越界和不完整发布', async () => {
    const store = new AlbumVideoStaging(),
      owner = {};
    await expect(store.start(owner, 16, '../file.zip')).rejects.toThrow('文件名');
    const upload = await store.start(owner, 16, 'fixture.zip');
    try {
      expect(() => store.complete(owner, upload.id)).toThrow('尚未');
      await store.append(owner, upload.id, 0, Buffer.alloc(16, 5));
      const path = store.complete(owner, upload.id);
      expect(path.endsWith('/fixture.zip')).toBe(true);
      expect(store.requirePath(owner, path)).toBe(path);
      expect(() => store.requirePath({}, path)).toThrow('失效');
      expect(() => store.requirePath(owner, '/private/fixture.zip')).toThrow('本次上传');
      expect(() => store.complete({}, upload.id)).toThrow('失效');
      expect(await readFile(path)).toEqual(Buffer.alloc(16, 5));
    } finally {
      await store.discard(owner, upload.id);
    }
  });
  it('正在使用的草稿附件不会被到期清理，操作结束后恢复回收', async () => {
    const store = new AlbumVideoStaging(20),
      owner = {};
    const upload = await store.start(owner, 16, 'fixture.txt');
    await store.append(owner, upload.id, 0, Buffer.alloc(16));
    const path = store.complete(owner, upload.id);
    try {
      await store.withPaths(
        { nodes: [{ media: { path } }], bytes: new Uint8Array(100) },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await store.cleanup();
          await access(path);
          await expect(store.discard(owner, upload.id)).rejects.toThrow('正在处理');
        },
      );
      await access(path);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await store.cleanup();
      await expect(access(path)).rejects.toThrow();
    } finally {
      await store.discard(owner, upload.id);
    }
  });
  it('取消使用中的暂存后不允许新读取，现有读取结束就能回收', async () => {
    const store = new AlbumVideoStaging();
    const owner = {};
    const upload = await store.start(owner, 16, 'fixture.txt');
    try {
      await store.append(owner, upload.id, 0, Buffer.alloc(16));
      const path = store.complete(owner, upload.id);
      await store.withPaths({ path }, async () => {
        await store.discardWhenIdle(owner, upload.id);
        expect(() => store.complete(owner, upload.id)).toThrow('失效');
        await store.cleanup();
        await access(path);
      });
      await store.cleanup();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await store.discard(owner, upload.id);
    }
  });
  it('大于旧上限的文件按段接收，拒绝错账号、错偏移、不完整取得，完成后删除本轮暂存', async () => {
    const store = new AlbumVideoStaging(),
      owner = {};
    const size = 2 * 1024 * 1024 + 16;
    const start = await store.start(owner, size);
    let path: string | undefined;
    try {
      expect(() => store.acquire(owner, start.id)).toThrow('尚未');
      await expect(store.append({}, start.id, 0, Buffer.of(1))).rejects.toThrow('失效');
      await expect(store.append(owner, start.id, 1, Buffer.of(1))).rejects.toThrow('偏移');
      for (let offset = 0; offset < size; ) {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, size - offset), 1);
        const result = await store.append(owner, start.id, offset, chunk);
        offset = result.offset;
      }
      path = store.acquire(owner, start.id);
      expect((await readFile(path)).length).toBe(size);
      await expect(store.append(owner, start.id, 0, Buffer.of(1))).rejects.toThrow('正在处理');
    } finally {
      await store.discard(owner, start.id, true);
    }
    expect(path).toBeDefined();
    await expect(access(path!)).rejects.toThrow();
  });
});
