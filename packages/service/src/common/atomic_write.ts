/**
 * 原子写小工具：写 `.tmp` 再 `rename` 覆盖目标（同目录 rename 在主流文件系统上是原子的）。
 *
 * 用途：助手/克隆体的 JSON 持久化（会话列表、对话历史、配置）都是「整文件覆盖」——
 * 直接 `writeFileSync` 时若进程在写到一半崩溃/断电，会留下截断的损坏 JSON，下次启动
 * 解析失败 → 整段数据丢失。改走「先写临时文件、成功后 rename」后，目标文件要么是旧的
 * 完整内容、要么是新的完整内容，永远不会是半截。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 原子地把 `data` 写到 `path`（UTF-8）。父目录不存在会先递归创建。
 * 失败时抛原始错误（调用方现有的 try/catch 兜底策略不变）。
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, data, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    // Best effort: persist the directory entry on filesystems that support it.
    try {
      const dirFd = openSync(parent, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Windows and some virtual filesystems do not permit fsync on directories.
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}
