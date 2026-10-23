import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupFileAndHashSync, hashFileSync } from '../src/account/db_repair/files';
import { repairDiskSpace, repairSpaceBudget } from '../src/account/db_repair/space';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, copyFileSync: vi.fn(fs.copyFileSync), writeSync: vi.fn(fs.writeSync) };
});

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-repair-storage-'));
  roots.push(root);
  const src = join(root, 'source.db');
  const dest = join(root, 'backup.db');
  writeFileSync(src, Buffer.alloc(1024 * 1024 + 19, 23));
  return { root, src, dest };
}
afterEach(() => {
  vi.mocked(copyFileSync).mockClear();
  vi.mocked(writeSync).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('独立备份与复制回退', () => {
  it('备份内容与哈希相同，之后改原库不影响备份，不使用硬链接', () => {
    const { src, dest } = fixture();
    const before = hashFileSync(src);
    expect(backupFileAndHashSync(src, dest)).toEqual(before);
    expect(statSync(src).ino).not.toBe(statSync(dest).ino);
    writeFileSync(src, 'changed');
    expect(hashFileSync(dest)).toEqual(before);
  });

  it('不支持克隆时回退分块复制', () => {
    const { src, dest } = fixture();
    vi.mocked(copyFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    expect(backupFileAndHashSync(src, dest)).toEqual(hashFileSync(src));
    expect(readFileSync(dest)).toEqual(readFileSync(src));
    expect(copyFileSync).toHaveBeenCalledWith(
      src,
      dest,
      constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL,
    );
  });

  it('磁盘错误不伪装成可回退，已有不同内容备份不覆盖', () => {
    const { src, dest } = fixture();
    vi.mocked(copyFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    expect(() => backupFileAndHashSync(src, dest)).toThrow('full');
    expect(existsSync(dest)).toBe(false);
    writeFileSync(dest, 'keep');
    expect(() => backupFileAndHashSync(src, dest)).toThrow();
    expect(readFileSync(dest, 'utf8')).toBe('keep');
  });

  it('回退复制写入停滞时关闭句柄并清理本次半成品，保留源库', () => {
    const { src, dest } = fixture();
    const before = hashFileSync(src);
    vi.mocked(copyFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    vi.mocked(writeSync).mockImplementationOnce(() => 0);
    expect(() => backupFileAndHashSync(src, dest)).toThrow(/未取得进展/);
    expect(existsSync(dest)).toBe(false);
    expect(hashFileSync(src)).toEqual(before);
  });
});

describe('分卷峰值预算', () => {
  const size = 1024 * 1024 * 1024;
  const base = {
    sourceDir: '/source',
    cacheDir: '/cache',
    dbBytes: size,
    walBytes: 0,
    backup: true,
    optimized: true,
  };
  const margin = 64 * 1024 * 1024;
  it('同卷取阶段峰值而非把不同时期的所有文件简单相加', () => {
    const result = repairSpaceBudget({
      ...base,
      probe: () => ({ volume: 'same', freeBytes: 1e12 }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.requiredBytes).toBe(size * 3 * 1.25 + margin);
  });
  it('分卷分别覆盖重建缓存和最终产物，旧模块预留四份缓存', () => {
    const probe = (path: string) => ({ volume: path, freeBytes: 1e12 });
    const result = repairSpaceBudget({ ...base, probe });
    expect(result.map((item) => item.requiredBytes)).toEqual([
      size * 3 * 1.25 + margin,
      size * 1.25 + margin,
    ]);
    expect(repairSpaceBudget({ ...base, optimized: false, probe })[0]!.requiredBytes).toBe(
      size * 4 * 1.25 + margin,
    );
  });
  it('无法识别卷时按可能共卷估算，不把未知当成空间充足', () => {
    const result = repairSpaceBudget({ ...base, probe: () => ({ volume: null, freeBytes: null }) });
    expect(
      result.every(
        (item) => item.freeBytes === null && item.requiredBytes === size * 3 * 1.25 + margin,
      ),
    ).toBe(true);
  });
  it('尚未创建的缓存子目录只读探测现有父卷', () => {
    const { root } = fixture();
    const path = join(root, 'missing', 'work');
    expect(repairDiskSpace(path).volume).toBe(repairDiskSpace(root).volume);
    expect(existsSync(path)).toBe(false);
  });
});
