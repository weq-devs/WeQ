import { lstat, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const RESOURCE_NODE_CAP = 2_000_000;

/** 只遍历真实目录/普通文件；不跟随链接，失败及上限显式返回给统计与删除调用方。 */
export async function walkResourceTree(
  root: string,
  visit: (path: string, stat: Stats) => void | Promise<void>,
  cap = RESOURCE_NODE_CAP,
) {
  const result = { present: false, complete: true, errors: 0, truncated: false };
  const base = resolve(root);
  const stack = [base];
  let boundary = base;
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    try {
      const info = await lstat(dir);
      const canonical = await realpath(dir);
      if (dir === base) boundary = canonical;
      if (
        !info.isDirectory() ||
        (canonical !== boundary && !canonical.startsWith(boundary + sep))
      ) {
        result.errors += 1;
        continue;
      }
      const entries = await readdir(dir, { withFileTypes: true });
      result.present = true;
      let pending: Promise<void>[] = [];
      for (const entry of entries) {
        if (visited >= cap) {
          result.truncated = true;
          break;
        }
        visited += 1;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) {
          pending.push(
            (async () => {
              try {
                const stat = await lstat(path);
                if (stat.isFile()) await visit(path, stat);
              } catch {
                result.errors += 1;
              }
            })(),
          );
          if (pending.length === 32) {
            await Promise.all(pending);
            pending = [];
          }
        }
      }
      await Promise.all(pending);
      if (result.truncated) break;
    } catch (error) {
      if (dir !== base || (error as NodeJS.ErrnoException).code !== 'ENOENT') result.errors += 1;
    }
  }
  result.complete = result.errors === 0 && !result.truncated;
  return result;
}
