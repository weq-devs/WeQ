/**
 * 修复链路的文件工具：一次读算 sha256、按块拷贝、静默删除、可用空间。
 *
 * 为什么自己写而不直接用 `copyFileSync`：备份与"替换前复核"都要 **sha256**，而
 * 90MB 级别的库"拷一遍 + 再读一遍算哈希"是两次全量 I/O。这里一边读一边算一边写，
 * 只有一次。
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** 一次全量读取后的文件指纹。 */
export interface FileFingerprint {
  bytes: number;
  sha256: string;
}

/** 分块大小：1 MiB（大库拷贝时既不让内存爆，也不至于每块都系统调用）。 */
const CHUNK_BYTES = 1024 * 1024;

/** 计算一个文件的 sha256 与字节数；文件不存在时抛（调用方负责给用户可读的错）。 */
export function hashFileSync(path: string): FileFingerprint {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * 把 `src` 拷贝到 `dest`（懒建父目录），同时算出源文件的 sha256。
 * 返回的指纹描述的是**源文件**（备份场景下就是修复前那一份）。
 */
export function copyFileAndHashSync(src: string, dest: string): FileFingerprint {
  mkdirSync(dirname(dest), { recursive: true });
  const inFd = openSync(src, 'r');
  const outFd = openSync(dest, 'w');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(inFd, buffer, 0, CHUNK_BYTES, null);
      if (read <= 0) break;
      writeSync(outFd, buffer, 0, read);
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** 文件字节数；不存在或读不了返回 `null`（界面展示用，不该因此报错）。 */
export function fileBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** `path` 所在分区的可用字节数；探测不了返回 `null`（不阻断修复）。 */
export function freeBytesAt(path: string): number | null {
  try {
    const stats = statfsSync(path);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/** 删文件（幂等，失败静默）。临时件清理用它。 */
export function removeQuietly(path: string | null | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 递归删目录（幂等，失败静默）。保留策略淘汰旧备份用它。 */
export function removeDirQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
}

/**
 * 把 `path` 里已有 `stamp` 前缀的临时产物挪走/删掉 —— 上一次修复中途被杀掉时留下的
 * `.nt_msg.db.weq-repair-*` 就在这里被清掉，避免永久占着 QQ 目录。
 */
export function sweepStaleProducts(dbDir: string, dbName: string): string[] {
  const prefix = `.${dbName}.weq-repair-`;
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dbDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dbDir, name);
    removeQuietly(full);
    removed.push(full);
  }
  return removed;
}

/**
 * SQLite 的 sidecar 文件：`-wal`（预写日志）与 `-shm`（它的共享内存索引）。
 *
 * QQ 的库是 **WAL 模式**（`journal_mode = wal`），所以这两个文件是常态：正常退出会
 * 把 WAL 合并回主文件并删掉它们，崩溃时则会留下带帧的 `-wal`。
 */
export function sqliteSidecarPaths(dbPath: string): { wal: string; shm: string } {
  return { wal: `${dbPath}-wal`, shm: `${dbPath}-shm` };
}

/**
 * 未合并的 WAL 有多大（字节）；没有 `-wal` 或它为空 ⇒ 0。
 *
 * 非零意味着**主文件缺失了最后一批改动**：页级读取（解密 / 坏页扫描 / 修复）看的只是
 * 主文件，`-wal` 里的帧不在其中。这个数字就是要如实告诉用户的东西。
 */
export function pendingWalBytes(dbPath: string): number {
  return fileBytes(sqliteSidecarPaths(dbPath).wal) ?? 0;
}

/**
 * 删掉主文件的 sidecar。
 *
 * **这一步非做不可**：主文件被换成另一份库之后，留在旁边的 `-wal` 不属于它。实测
 * （毁页库 → 修复产物换进主文件，旁边留一个 16 KiB 的旧 `-wal`）：整个库连
 * `PRAGMA journal_mode` 都读不了，native 报的是「Failed to decrypt database with
 * provided key」—— 用户会以为修复把库弄坏了或密钥不对。对照实验：产物单独一份、
 * 或只多一个旧 `-shm`、或只有**空**`-wal`，都一切正常，所以罪魁就是非空 `-wal` 的
 * 帧。空的 sidecar 无害，但这里按"有就删"处理，不留任何含糊状态。
 */
export function removeSqliteSidecars(dbPath: string): string[] {
  const { wal, shm } = sqliteSidecarPaths(dbPath);
  const removed: string[] = [];
  for (const path of [wal, shm]) {
    if (!existsSync(path)) continue;
    removeQuietly(path);
    if (!existsSync(path)) removed.push(path);
  }
  return removed;
}

/** 原子替换：同目录 `rename`（Windows 的复用语义与 `writeFileAtomicSync` 一致）。 */
export function replaceFileSync(from: string, to: string): void {
  renameSync(from, to);
}

/** 目标路径是否就是同一个文件（避免把自己拷到自己身上）。 */
export function sameFilePath(left: string, right: string): boolean {
  if (left === right) return true;
  return existsSync(left) && existsSync(right) && statSync(left).ino === statSync(right).ino;
}
