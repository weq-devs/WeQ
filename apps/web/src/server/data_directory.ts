import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function realLocation(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path === dirname(path)) throw error;
    return join(realLocation(dirname(path)), basename(path));
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function standaloneDataDirectory(configured: string, desktop: string): string {
  const target = realLocation(resolve(configured));
  const desktopRoot = realLocation(resolve(desktop));
  if (contains(desktopRoot, target) || contains(target, desktopRoot))
    throw new Error('WEQ_DATA_DIR 需使用独立目录。请通过 WeQ 备份导入桌面数据。');
  return target;
}
