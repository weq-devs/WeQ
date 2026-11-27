import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertQqDatabaseWriteAllowed, beginQqWrite, qqDatabaseReadOnly } from './maintenance';

type Target = string | { path: string; tree: true };
let dataRoots: () => readonly string[] = () => [];

export function configureQqFileWriteRoots(roots: () => readonly string[]): void {
  dataRoots = roots;
}

function realLocation(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is an unresolved destination, not a missing path.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realLocation(parent), basename(path));
  }
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

/** 树操作还需要检查目标是否包含 QQ 数据目录。移动或替换时同时传入源和目标。 */
export function qqFileWriteTouchesData(
  targets: Target | readonly Target[],
  roots?: readonly string[],
): boolean {
  const paths = typeof targets === 'string' || 'path' in targets ? [targets] : targets;
  if (!paths.length) return false;
  const protectedRoots = roots ?? dataRoots();
  if (!protectedRoots.length) return false;
  return paths.some((target) => {
    const absolute = resolve(typeof target === 'string' ? target : target.path);
    const overlaps = (root: string, path: string) =>
      contains(root, path) || (typeof target !== 'string' && contains(path, root));
    if (protectedRoots.some((root) => overlaps(resolve(root), absolute))) return true;
    const actual = realLocation(absolute);
    return protectedRoots.some((root) => {
      try {
        return overlaps(realLocation(resolve(root)), actual);
      } catch (error) {
        if (['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return false;
        throw error;
      }
    });
  });
}

export function assertQqFileWriteAllowed(targets: Target | readonly Target[]): void {
  if (qqDatabaseReadOnly() && qqFileWriteTouchesData(targets)) assertQqDatabaseWriteAllowed();
}

export function beginQqFileWrite(targets: Target | readonly Target[]): () => void {
  return qqFileWriteTouchesData(targets) ? beginQqWrite() : () => {};
}

export async function withQqFileWrite<T>(
  targets: Target | readonly Target[],
  write: () => Promise<T>,
): Promise<T> {
  const finish = beginQqFileWrite(targets);
  try {
    return await write();
  } finally {
    finish();
  }
}
