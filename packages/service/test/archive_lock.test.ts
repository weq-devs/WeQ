import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { acquireArchiveLock } from '../src/account/export/archive_lock';

it('自动回收已退出本机写入者的锁，新锁立即记录当前进程且恢复互斥文件被清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-archive-lock-'));
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('exited'), { code: 'ESRCH' });
  });
  try {
    const path = join(root, 'archive.weq-lock');
    await writeFile(path, JSON.stringify({ pid: 424242, host: hostname() }));
    const handle = await acquireArchiveLock(path);
    try {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        pid: process.pid,
        host: hostname(),
      });
    } finally {
      await handle.close();
    }
    expect(await readdir(root)).toEqual(['archive.weq-lock']);
    expect(kill).toHaveBeenCalledWith(424242, 0);
  } finally {
    kill.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['active', 'foreign', 'unknown'])(
  '保留 %s 锁，不覆盖正在运行或无法归属的写入者',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-archive-lock-'));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const path = join(root, 'archive.weq-lock');
      const text =
        kind === 'unknown'
          ? 'unknown-lock'
          : JSON.stringify({ pid: 424242, host: kind === 'foreign' ? 'other-host' : hostname() });
      await writeFile(path, text);
      await expect(acquireArchiveLock(path)).rejects.toThrow('归档正在更新');
      expect(await readFile(path, 'utf8')).toBe(text);
      expect(await readdir(root)).toEqual(['archive.weq-lock']);
    } finally {
      kill.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
