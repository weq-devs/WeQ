import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { freeBytesAt } from './files';

export interface RepairDiskSpace {
  volume: string | null;
  freeBytes: number | null;
}

export interface RepairSpaceBudget {
  paths: string[];
  freeBytes: number | null;
  requiredBytes: number;
}

/** 未创建的子目录按最近的现有父目录探测，不为预检落盘。 */
export function repairDiskSpace(path: string): RepairDiskSpace {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  try {
    return { volume: String(statSync(current).dev), freeBytes: freeBytesAt(current) };
  } catch {
    return { volume: null, freeBytes: null };
  }
}

/** 按阶段取同卷峰值；不预支 CoW 节省，也不假设重建库一定缩小。 */
export function repairSpaceBudget(options: {
  sourceDir: string;
  cacheDir: string;
  dbBytes: number;
  walBytes: number;
  backup: boolean;
  optimized: boolean;
  probe?: (path: string) => RepairDiskSpace;
}): RepairSpaceBudget[] {
  const probe = options.probe ?? repairDiskSpace;
  const paths = [options.cacheDir, options.sourceDir];
  const disks = paths.map(probe);
  const size = options.dbBytes + options.walBytes;
  const backup = options.backup ? size : 0;
  // 重建 / 加密 / 提交与回滚。WAL 可能让主文件扩展，原库卷也预留这部分。
  const stages = [
    [backup + size * 2, options.walBytes],
    [
      backup + size * (options.optimized ? 1 : 3),
      (options.optimized ? size : 0) + options.walBytes,
    ],
    [backup + (options.optimized ? 0 : size), size + options.walBytes],
  ];
  const groups = new Map<string, number[]>();
  disks.forEach((disk, index) => {
    const key = disk.volume ?? `unknown-${index}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return [...groups.values()].map((indices) => {
    // 无法确认卷身份时按两处同卷的较高预算，避免把同卷误判成独立空间。
    const budgetIndices = indices.some((index) => disks[index]!.volume === null) ? [0, 1] : indices;
    const peak = Math.max(
      ...stages.map((stage) => budgetIndices.reduce((sum, index) => sum + stage[index]!, 0)),
    );
    const free = indices
      .map((index) => disks[index]!.freeBytes)
      .filter((value): value is number => value !== null);
    return {
      paths: indices.map((index) => paths[index]!),
      freeBytes: free.length ? Math.min(...free) : null,
      // 索引排序、恢复表及文件系统开销有波动，另留 25% 与 64 MiB；不是硬上界。
      requiredBytes: Math.ceil(peak * 1.25) + 64 * 1024 * 1024,
    };
  });
}
