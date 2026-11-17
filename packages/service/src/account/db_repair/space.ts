import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freeBytesAt } from './files';

export interface RepairDiskSpace {
  volume: string | null;
  freeBytes: number | null;
}

export interface RepairSpaceBudget {
  paths: string[];
  freeBytes: number | null;
  requiredBytes: number;
  recommendedBytes: number;
}

export interface RepairStorageStatus {
  cachePath: string;
  phase: string;
  space: RepairSpaceBudget[];
  warning?: 'insufficient-space' | 'space-margin';
}

/** 仅统计本次工作目录；逻辑长度用于预测产物，已分配块用于扣除已经实际写入的空间。 */
export function repairWorkingBytes(path: string): {
  allocated: number;
  rebuilt: number;
  sourcePresent: boolean;
} {
  let allocated = 0;
  let rebuilt = 0;
  let sourcePresent = false;
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        const child = repairWorkingBytes(full);
        allocated += child.allocated;
        rebuilt += child.rebuilt;
        sourcePresent ||= child.sourcePresent;
      } else if (entry.isFile()) {
        const stat = statSync(full);
        allocated += typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
        if (entry.name.endsWith('-rebuilt.db')) rebuilt += stat.size;
        if (entry.name.endsWith('-source.db')) sourcePresent = true;
      }
    }
  } catch {
    // 文件可能刚被原生重建删除；下一个进度或定时采样会重新统计。
  }
  return { allocated, rebuilt, sourcePresent };
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
  /** 进行中只预算后续阶段，减去本次已经写入的临时件，不重复扣除原库或已有备份。 */
  current?: {
    phase: string;
    cacheBytes: number;
    productBytes: number;
    rebuiltBytes: number;
    backupRemainingBytes: number;
  };
}): RepairSpaceBudget[] {
  const probe = options.probe ?? repairDiskSpace;
  const paths = [options.cacheDir, options.sourceDir];
  const disks = paths.map(probe);
  const size = options.dbBytes + options.walBytes;
  const current = options.current;
  const phase = current?.phase.toLowerCase();
  const backup = current ? current.backupRemainingBytes : options.backup ? size : 0;
  const output = Math.max(4096, current?.rebuiltBytes ? current.rebuiltBytes + 4096 : size);
  // 重建 / 加密 / 提交与回滚。WAL 可能让主文件扩展，原库卷也预留这部分。
  let stages = [
    [backup + size * 2, options.walBytes],
    [
      backup + size * (options.optimized ? 1 : 3),
      (options.optimized ? size : 0) + options.walBytes,
    ],
    [backup + (options.optimized ? 0 : size), size + options.walBytes],
  ];
  if (current) {
    if (phase === 'encrypt') {
      stages = options.optimized
        ? [
            [output, output],
            [0, output],
          ]
        : [
            [size + output * 2, output],
            [0, output],
          ];
    } else if (['restore', 'verify', 'source-check', 'swapping'].includes(phase ?? '')) {
      // 加密产物已经写完，后续为校验、删除和同卷 rename，不再预留一份完整库。
      stages = [[current.cacheBytes, current.productBytes]];
    } else {
      const rebuilt = Math.max(size, current.rebuiltBytes);
      stages = [
        [backup + size + rebuilt, options.walBytes],
        [
          backup + rebuilt * (options.optimized ? 1 : 3),
          (options.optimized ? rebuilt : 0) + options.walBytes,
        ],
        [backup + (options.optimized ? 0 : rebuilt), rebuilt + options.walBytes],
      ];
    }
    stages = stages.map(([cache, source]) => [
      cache! - current.cacheBytes,
      source! - current.productBytes,
    ]);
  }
  const groups = new Map<string, number[]>();
  disks.forEach((disk, index) => {
    const key = disk.volume ?? `unknown-${index}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return [...groups.values()].map((indices) => {
    // 无法确认卷身份时按两处同卷的较高预算，避免把同卷误判成独立空间。
    const budgetIndices = indices.some((index) => disks[index]!.volume === null) ? [0, 1] : indices;
    const peak = Math.max(
      0,
      ...stages.map((stage) => budgetIndices.reduce((sum, index) => sum + stage[index]!, 0)),
    );
    const free = indices
      .map((index) => disks[index]!.freeBytes)
      .filter((value): value is number => value !== null);
    return {
      paths: indices.map((index) => paths[index]!),
      freeBytes: free.length ? Math.min(...free) : null,
      requiredBytes: peak,
      // 余量只是建议，与预计峰值分开；两者都不是实际占用的硬上界。
      recommendedBytes: Math.ceil(peak * 1.25) + 64 * 1024 * 1024,
    };
  });
}
