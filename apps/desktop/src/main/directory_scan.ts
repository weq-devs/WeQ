import { opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** 命中目录后不再向其媒体子树深入；不跟随符号链接，限制遍历量。 */
export async function scanDirectories<T>(
  directory: string,
  inspect: (path: string) => Promise<T[]>,
  recursive = false,
) {
  const root = await realpath(directory);
  const queue = [{ path: root, depth: 0 }];
  const items: T[] = [];
  let visited = 0;
  let truncated = false;
  let unreadable = 0;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (++visited > 4096) {
      truncated = true;
      break;
    }
    let found: T[];
    try {
      found = await inspect(current.path);
    } catch (error) {
      if (current.depth === 0) throw error;
      unreadable++;
      continue;
    }
    const remaining = 64 - items.length;
    items.push(...found.slice(0, remaining));
    if (found.length > remaining) truncated = true;
    if (items.length >= 64) {
      truncated ||= index + 1 < queue.length;
      break;
    }
    if (found.length || (!recursive && current.depth >= 1)) continue;
    try {
      const dir = await opendir(current.path);
      for await (const entry of dir) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (queue.length >= 4096) {
          truncated = true;
          break;
        }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    } catch (error) {
      if (current.depth === 0) throw error;
      unreadable++;
    }
  }
  return { items, truncated, unreadable };
}
