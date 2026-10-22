import { randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 仅发布完整文件，不覆盖同名原件；失败时只清理本轮创建的中间文件。 */
export async function writeWeqBackupExclusive(path: string, bytes: Buffer): Promise<void> {
  const temp = join(dirname(path), `.weq-backup-${randomUUID()}.part`);
  const output = await open(temp, 'wx', 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
    await output.close();
    await link(temp, path);
  } finally {
    await output.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}
