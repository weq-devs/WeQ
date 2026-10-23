import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listDressPreviewFiles, measureStorage, type StorageUsageItem } from './storage_usage';

export interface StorageCleanupResult {
  at: string;
  cleared: string[];
  failed: Array<{ label: string; error: string }>;
  freedBytes: number;
}

export interface StorageCleanupPlan {
  targets: StorageUsageItem[];
  protectedPaths: string[];
  reportPath: string;
  lockPath?: string;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** 只接受后端重新解析出的目标；渲染进程不能传路径或构造清理计划。 */
export function selectStorageCleanupTargets(
  items: StorageUsageItem[],
  ids: string[],
): StorageUsageItem[] {
  const selected = [...new Set(ids)].map((id) => items.find((item) => item.id === id));
  if (!selected.length || selected.some((item) => !item?.clearable || item.incomplete)) {
    throw new Error('清除项目已变化、不可清除或读取不完整，请刷新后重新选择');
  }
  return selected.filter((item): item is StorageUsageItem => Boolean(item));
}

/** 只能在宿主进程已经退出后调用，避免打开的 SQLite、模型及配置状态被删除后写回。 */
export async function executeStorageCleanup(
  plan: StorageCleanupPlan,
): Promise<StorageCleanupResult> {
  const result: StorageCleanupResult = {
    at: new Date().toISOString(),
    cleared: [],
    failed: [],
    freedBytes: 0,
  };
  for (const item of plan.targets) {
    try {
      const path = resolve(item.path);
      if (
        !item.clearable ||
        item.incomplete ||
        !isAbsolute(item.path) ||
        path === dirname(path) ||
        [...plan.protectedPaths, dirname(plan.reportPath)].some((protectedPath) =>
          contains(path, resolve(protectedPath)),
        )
      ) {
        throw new Error('目标包含受保护的应用或维护资源，未清除');
      }
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          result.cleared.push(item.label);
          continue;
        }
        throw error;
      }
      if (info.isSymbolicLink() || (await realpath(path)) !== path)
        throw new Error('目标路径现为符号链接，未清除');
      const before = await measureStorage(path);
      if (before.incomplete) throw new Error('读取不完整，未清除');
      if (item.cleanupKind === 'dress-previews' || item.cleanupKind === 'dress-data') {
        const previews = await listDressPreviewFiles(path);
        if (previews.incomplete) throw new Error('预览文件读取不完整，未清除');
        const files = new Set(previews.files);
        const targets =
          item.cleanupKind === 'dress-previews'
            ? previews.files
            : (await readdir(path))
                .map((name) => join(path, name))
                .filter((file) => !files.has(file));
        for (const file of targets)
          await rm(file, { recursive: item.cleanupKind === 'dress-data', force: true });
      } else {
        await rm(path, { recursive: true, force: true });
      }
      const after = await measureStorage(path);
      result.freedBytes += Math.max(0, before.bytes - after.bytes);
      result.cleared.push(item.label);
    } catch (error) {
      result.failed.push({
        label: item.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await mkdir(dirname(plan.reportPath), { recursive: true });
  await writeFile(plan.reportPath, JSON.stringify(result), { mode: 0o600 });
  return result;
}

export async function readStorageCleanupResult(path: string): Promise<StorageCleanupResult | null> {
  try {
    const result: StorageCleanupResult = JSON.parse(await readFile(path, 'utf8'));
    if (
      !result ||
      !Array.isArray(result.cleared) ||
      !Array.isArray(result.failed) ||
      typeof result.freedBytes !== 'number'
    )
      return null;
    return result;
  } catch {
    return null;
  }
}
