import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { exportAvatars, exportGuildAvatars } from '../src/account/export/avatar_export';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['friend', 'guild'] as const)(
  '%s 头像导出取消后不启动后续读取，也不写入返回中的头像',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-avatar-cancel-'));
    roots.push(root);
    const controller = new AbortController();
    const get = vi.fn(async () => {
      controller.abort();
      return { contentType: 'image/png', data: Buffer.from('synthetic-avatar') };
    });
    const cache = { get } as unknown as Parameters<typeof exportAvatars>[0];
    const options = { signal: controller.signal, concurrency: 1 };
    const task =
      kind === 'friend'
        ? exportAvatars(cache, new Set(['10001', '10002', '10003']), root, options)
        : exportGuildAvatars(
            cache,
            ['1', '2', '3'].map((id) => ({ id, url: `https://example.invalid/${id}.png` })),
            root,
            options,
          );
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, 'avatars'))).toEqual([]);
  },
);
