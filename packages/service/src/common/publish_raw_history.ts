import { createHash } from 'node:crypto';
import {
  mkdirSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  linkSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/** Copy immutable content-addressed responses into a private export stage. */
export function publishRawHistory(
  root: string,
  snapshotPath: string,
  entries: ReadonlyArray<{ file: string; sha256: string }>,
  allowed: RegExp,
): void {
  const hashFile = (path: string): string => {
    if (!lstatSync(path).isFile()) throw new Error('历史响应不是普通文件。');
    const fd = openSync(path, 'r'),
      hash = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    try {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        hash.update(buffer.subarray(0, count));
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest('hex');
  };
  const files = new Map(entries.map((entry) => [entry.file, entry.sha256]));
  for (const [file, expected] of files) {
    if (!allowed.test(file) || !/^[a-f0-9]{64}$/.test(expected))
      throw new Error('历史响应路径或校验值无效。');
    const source = join(root, file),
      target = join(dirname(snapshotPath), file);
    if (hashFile(source) !== expected) throw new Error('历史响应校验失败。');
    mkdirSync(dirname(target), { recursive: true });
    try {
      linkSync(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && hashFile(target) === expected) continue;
      if (code !== 'EXDEV') throw error;
      copyFileSync(source, target);
      if (hashFile(target) !== expected) throw new Error('历史响应复制校验失败。');
    }
  }
}
