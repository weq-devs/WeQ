import {
  accessSync,
  constants,
  existsSync,
  statSync,
  statfsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function inspectDestination(path: string) {
  let directory = path;
  while (!existsSync(directory)) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('找不到导出目录所在卷。');
    directory = parent;
  }
  if (!statSync(directory).isDirectory()) directory = dirname(directory);
  accessSync(directory, constants.W_OK);
  const fs = statfsSync(directory);
  return { directory, availableBytes: Number(fs.bavail) * Number(fs.bsize) };
}

export function outputBytes(path: string): number {
  const stat = lstatSync(path);
  if (stat.isFile()) return stat.size;
  if (stat.isSymbolicLink()) throw new Error('导出产物包含未核验的链接，不能按普通文件估算。');
  if (!stat.isDirectory()) throw new Error('导出产物不是普通文件或目录。');
  let bytes = 0;
  for (const name of readdirSync(path)) bytes += outputBytes(join(path, name));
  return bytes;
}

export function assertDestinationCapacity(
  target: string,
  source: string | readonly string[],
): void {
  const sources = typeof source === 'string' ? [source] : source;
  const required = sources.reduce((total, path) => total + outputBytes(path), 0);
  const { availableBytes } = inspectDestination(dirname(target));
  if (required > availableBytes)
    throw new Error(`目标卷可用空间不足：需要 ${required} 字节，可用 ${availableBytes} 字节。`);
}
