import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { AlbumVideoStaging } from '../src/main/ipc/routers/album_video_staging';

describe('Web 视频流式暂存', () => {
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
