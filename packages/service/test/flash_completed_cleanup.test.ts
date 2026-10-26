// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FlashTransferDownloadManager } from '../src/account/flashtransfer/manager';

it('只清除指定的成功下载记录，保留其他状态、后来完成的任务及下载原件，重载后仍生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weq-flash-clear-'));
  try {
    const file = join(dir, 'original.txt');
    await writeFile(file, 'fixture');
    const statuses = ['done', 'failed', 'cancelled', 'pending', 'resolving', 'downloading', 'done'];
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify(statuses.map((status, i) => ({ id: String(i), status, targetPath: file }))),
    );
    const manager = new FlashTransferDownloadManager(dir);
    await manager.load();
    expect(await manager.clearCompleted(['0', '0', '1', '2', '3', '4', '5'])).toBe(1);
    await manager.load();
    expect(
      manager
        .list()
        .map((task) => task.id)
        .sort(),
    ).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(await readFile(file, 'utf8')).toBe('fixture');
    expect(await manager.clearCompleted([])).toBe(0);
    await rm(join(dir, 'tasks.json'));
    await mkdir(join(dir, 'tasks.json'));
    await expect(manager.clearCompleted(['6'])).rejects.toThrow();
    expect(manager.list().some((task) => task.id === '6')).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
