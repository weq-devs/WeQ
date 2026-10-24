import { createHash } from 'node:crypto';
import { createReadStream, statSync, lstatSync } from 'node:fs';
import type { ExportTask } from './task_manager';

export function sourceStamp(path: string): string {
  const files = [path, `${path}-wal`].map((file) => {
    try {
      const s = statSync(file, { bigint: true });
      return {
        file,
        ino: String(s.ino),
        size: String(s.size),
        mtime: String(s.mtimeNs),
        ctime: String(s.ctimeNs),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file !== path)
        return { file, absent: true };
      throw error;
    }
  });
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function exportOptionsHash(task: ExportTask): string {
  const options = {
    kind: task.kind,
    conv: task.conv,
    name: task.name,
    formats: task.formats ?? [task.format],
    range: task.range ?? null,
    filter: task.filter ?? null,
    media: task.media ?? null,
    avatar: task.exportAvatar ?? false,
    chatlab: task.chatlab ?? false,
    dress: task.dress ?? null,
  };
  return createHash('sha256').update(JSON.stringify(options)).digest('hex');
}

export function messageSelectionHash(task: ExportTask): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: task.kind,
        conv: task.conv,
        range: task.range ?? null,
        filter: task.filter ?? null,
      }),
    )
    .digest('hex');
}

export async function fileSha256(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile()) throw new Error('格式断点不是普通文件。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  const after = lstatSync(path, { bigint: true });
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error('校验期间导出文件发生变化。');
  return hash.digest('hex');
}

export function roamingDigest(rows: readonly unknown[]): string {
  const hash = createHash('sha256');
  const entries = rows
    .map((row) =>
      createHash('sha256')
        .update(
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        )
        .digest('hex'),
    )
    .sort();
  for (const entry of entries) hash.update(entry).update('\n');
  return hash.digest('hex');
}
