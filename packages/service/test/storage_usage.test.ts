import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weq-storage-test-')));
  roots.push(root);
  const service = new UserConfigService({ appDataRoot: () => root });
  const file = (rel: string, size: number) => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(size));
    return path;
  };
  return { root, service, file };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WeQ 存储管理', () => {
  it('统计模型、持久数据及未知文件，但只开放明确可重建的缓存', async () => {
    const f = fixture();
    f.file('cache/avatar/a', 11);
    f.file('cache/linkpreview/a', 12);
    f.file('cache/ocr/result.json', 13);
    f.file('cache/agentlab/data', 14);
    f.file('cache/search-index/index', 15);
    f.file('models/local/model', 16);
    f.file('merge-forward/archive', 17);
    f.file('unknown.bin', 18);
    const items = await f.service.listStorageUsage();
    for (const [suffix, bytes, clearable] of [
      ['cache/avatar', 11, true],
      ['cache/linkpreview', 12, true],
      ['cache/ocr', 13, false],
      ['cache/agentlab', 14, false],
      ['cache/search-index', 15, false],
      ['models', 16, false],
      ['merge-forward', 17, false],
      ['unknown.bin', 18, false],
    ] as const) {
      expect(items.find((item) => item.path === join(f.root, suffix))).toMatchObject({
        bytes,
        clearable,
      });
    }
    const protectedItems = items.filter((item) => !item.clearable);
    expect(protectedItems.every((item) => item.reason.length > 0)).toBe(true);
    await f.service.clearCache([...items.map((item) => item.id), '../models']);
    expect(existsSync(join(f.root, 'cache/avatar/a'))).toBe(false);
    expect(existsSync(join(f.root, 'cache/ocr/result.json'))).toBe(true);
    expect(existsSync(join(f.root, 'models/local/model'))).toBe(true);
  });

  it('自定义缓存、默认缓存和嵌套宿主目录不漏算、不重复计数', async () => {
    const f = fixture();
    f.file('cache/voice/a', 20);
    f.file('custom/media/a', 30);
    f.file('runtime/Cache/a', 40);
    f.service.setCacheDirOverride(join(f.root, 'custom'));
    const baseline = await f.service.listStorageUsage();
    const items = await f.service.listStorageUsage([
      { path: join(f.root, 'runtime'), label: '桌面运行数据' },
    ]);
    expect(items.reduce((sum, item) => sum + item.bytes, 0)).toBe(
      baseline.reduce((sum, item) => sum + item.bytes, 0),
    );
    expect(items.filter((item) => item.path.endsWith('/Cache'))).toHaveLength(1);
    const result = await f.service.clearCache();
    expect(result.freedBytes).toBe(50);
    expect(existsSync(join(f.root, 'runtime/Cache/a'))).toBe(true);
  });

  it('符号链接不遍历、不清理，空选择不等于全部清理', async () => {
    const f = fixture();
    const other = fixture();
    other.file('original', 100);
    mkdirSync(join(f.root, 'cache'), { recursive: true });
    symlinkSync(other.root, join(f.root, 'cache/media'), 'dir');
    f.file('cache/avatar/a', 10);
    const items = await f.service.listStorageUsage();
    expect(items.find((item) => item.id === 'media')?.clearable).toBe(false);
    await f.service.clearCache([]);
    expect(existsSync(join(f.root, 'cache/avatar/a'))).toBe(true);
    await f.service.clearCache(['media']);
    expect(existsSync(join(other.root, 'original'))).toBe(true);
  });

  it('缓存中嵌套的宿主数据根不能被整目录清理，别名和文件根只统计一次', async () => {
    const f = fixture();
    f.file('cache/media/preview', 20);
    f.file('cache/media/protected/session', 30);
    f.file('installer.bin', 40);
    symlinkSync(join(f.root, 'cache/media/protected'), join(f.root, 'alias'), 'dir');
    const roots = [
      { path: join(f.root, 'cache/media/protected'), label: '运行会话' },
      { path: join(f.root, 'alias'), label: '运行会话别名' },
      { path: join(f.root, 'installer.bin'), label: '安装文件' },
    ];
    const items = await f.service.listStorageUsage(roots);
    expect(items.find((item) => item.id === 'media')).toMatchObject({
      bytes: 20,
      clearable: false,
    });
    expect(items.filter((item) => item.path.endsWith('/session'))).toHaveLength(1);
    expect(items.find((item) => item.path === join(f.root, 'installer.bin'))).toMatchObject({
      bytes: 40,
      clearable: false,
    });
    await f.service.clearCache(['media'], roots);
    expect(existsSync(join(f.root, 'cache/media/protected/session'))).toBe(true);
    expect(existsSync(join(f.root, 'cache/media/preview'))).toBe(true);
  });
});
