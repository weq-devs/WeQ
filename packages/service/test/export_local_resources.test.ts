import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarCacheService } from '../src/bootstrap/media_cache';
import { exportAvatars } from '../src/account/export/avatar_export';
import { exportDressAssets } from '../src/account/export/dress_export';
import type { DressService } from '../src/account/dress_service';

describe('仅本地资源导出', () => {
  it('头像缓存未命中不调用下载，命中则原样导出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-local-export-'));
    const get = vi.fn();
    const getLocal = vi.fn(async (url: string) =>
      url.includes('10001')
        ? { data: Buffer.from('local-image'), contentType: 'image/png', fromCache: true }
        : null,
    );
    try {
      await mkdir(join(root, 'avatars'));
      const result = await exportAvatars(
        { get, getLocal } as unknown as AvatarCacheService,
        ['10001', '10002'],
        root,
        { localOnly: true },
      );
      expect(result).toMatchObject({ ok: 1, failed: 1 });
      expect(get).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'avatars', '10001.png'), 'utf8')).toBe('local-image');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('装扮逐类别执行补全意图，本地气泡和挂件不触发 fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-local-dress-'));
    const file = join(root, 'fixture.png');
    await writeFile(file, 'local-image');
    const fetchBubble = vi.fn(),
      resolvePendantAnimation = vi.fn();
    const fetchFont = vi.fn(async () => ({ file, family: 'fixture' }));
    const bubbleConfig = vi.fn(async (_id: number, localOnly: boolean) => {
      expect(localOnly).toBe(true);
      return null;
    });
    const pendantStaticFile = vi.fn(async (_id: number, localOnly: boolean) => {
      expect(localOnly).toBe(true);
      return file;
    });
    const dress = {
      hasLocal: () => true,
      localBubble: () => ({
        localFile: file,
        slice: { top: 1, right: 1, bottom: 1, left: 1 },
        imageSize: { width: 2, height: 2 },
        textColor: '#000',
      }),
      localPendant: () => null,
      fetchBubble,
      fetchFont,
      resolvePendantAnimation,
      bubbleConfig,
      pendantStaticFile,
    } as unknown as DressService;
    try {
      const result = await exportDressAssets(
        dress,
        root,
        { bubbles: new Set([1]), fonts: new Set([2]), widgets: new Set([3]), byMsg: new Map() },
        { bubble: true, font: true, widget: true },
        undefined,
        { bubble: false, font: true, widget: false },
      );
      expect(result.ok).toBe(3);
      expect(fetchBubble).not.toHaveBeenCalled();
      expect(resolvePendantAnimation).not.toHaveBeenCalled();
      expect(fetchFont).toHaveBeenCalledWith(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
