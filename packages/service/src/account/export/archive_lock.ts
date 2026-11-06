import { hostname } from 'node:os';
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises';

const busy = () => new Error('归档正在更新，或遗留锁无法确认归属；请稍后重试。');

/** 仅回收本机已退出进程的锁；同机恢复器以独立排他文件串行恢复。 */
export async function acquireArchiveLock(path: string): Promise<FileHandle> {
  const create = async () => {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close();
      await unlink(path);
      throw error;
    }
  };
  try {
    return await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let guard: FileHandle;
  const recovery = `${path}.recovery`;
  try {
    guard = await open(recovery, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy();
    throw error;
  }
  try {
    let previous: FileHandle;
    try {
      previous = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await create();
      throw error;
    }
    try {
      const info = await previous.stat();
      if (!info.isFile() || info.size > 65536) throw busy();
      let owner: { pid?: unknown; host?: unknown };
      try {
        owner = JSON.parse(await previous.readFile('utf8'));
      } catch {
        throw busy();
      }
      if (
        !owner ||
        owner.host !== hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0
      )
        throw busy();
      try {
        process.kill(Number(owner.pid), 0);
        throw busy();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy();
      }
      const current = await lstat(path);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
        throw busy();
      await unlink(path);
      return await create();
    } finally {
      await previous.close();
    }
  } finally {
    await guard.close();
    await unlink(recovery);
  }
}
