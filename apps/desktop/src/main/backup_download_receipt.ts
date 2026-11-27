import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { JsonStore } from '@weq/service/json-store';
import { z } from 'zod/v3';

const receipt = z.object({
  owner: z.string(),
  path: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
type Receipt = z.infer<typeof receipt>;

function storeFor(root: string) {
  return new JsonStore<Receipt[]>(join(root, 'config', 'backup-downloads.json'), () => [], {
    normalize: (value) => z.array(receipt).parse(value),
  });
}

export function recordBackupDownload(root: string, owner: string, path: string, bytes: Buffer) {
  const store = storeFor(root);
  store.replace([
    ...store.data.filter((row) => row.owner !== owner).slice(-31),
    { owner, path, hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
  ]);
}

export function recentBackupDownload(root: string, owner: string) {
  const saved = storeFor(root).data.find((row) => row.owner === owner);
  return saved ? { name: basename(saved.path) } : undefined;
}

export async function resolveBackupDownload(root: string, exportRoot: string, owner: string) {
  const saved = storeFor(root).data.find((row) => row.owner === owner);
  if (!saved) throw new Error('没有本设备可重新下载的备份。');
  const [base, path] = await Promise.all([realpath(exportRoot), realpath(saved.path)]).catch(() => {
    throw new Error('备份文件已移动或删除。');
  });
  const rel = relative(base, path);
  const info = await stat(path);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    isAbsolute(rel) ||
    !info.isFile() ||
    info.size !== saved.bytes
  )
    throw new Error('备份文件已变化，请重新导出。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== saved.hash) throw new Error('备份文件已变化，请重新导出。');
  return { path, name: basename(saved.path) };
}
