/**
 * 旧版误修复的页布局检测。
 *
 * 背景：1 GiB 以上的 QQ 库在旧版本里会被误判成损坏，旧修复把 standard SQLite 的
 * 页布局写进带 QQ 头的产物。standard 的保留页是第 262145 页，QQ 的保留页是第
 * 262144 页 —— 两者只差一页，但一旦库超过 1 GiB，继续按 QQ 布局读就会把真实数据页
 * 当成保留页。
 *
 * 这里**只允许两个判据**（用户明确要求，别再加旧修复记录、结构检查之类的旁证）：
 *
 *   1. 文件是否大于 1 GiB；
 *   2. 第 262144 / 262145 页是否全零。
 *
 * 页号按**逻辑页**算：QQ 库的镜像从 1024 字节自定义头之后开始，所以物理偏移是
 * `headerOffset + (pgno - 1) * 4096`。检测只读原始字节，不经过 SQLite，也不依赖
 * 当前进程的 pager 布局。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** QQ / SQLite 的页大小（与 nt_helper 的 `PAGE_SIZE` 一致）。 */
export const LAYOUT_PAGE_SIZE = 4096;
/** 1 GiB —— 用户指定的唯一大小判据。 */
export const LAYOUT_MIN_BYTES = 1024 * 1024 * 1024;
/** standard SQLite 的保留页（1 GiB 处）。 */
export const STANDARD_RESERVED_PAGE = 262145;
/** QQ 布局的保留页（1 GiB - 1024 处）。 */
export const QQ_RESERVED_PAGE = 262144;

export type DbLayoutKind = 'qq' | 'standard' | 'unknown';
export type DbLayoutPageState = 'data' | 'zero' | 'missing';

export interface DbLayoutProbe {
  dbPath: string;
  fileBytes: number;
  headerOffset: number;
  pageSize: number;
  pageCount: number;
  page262144: DbLayoutPageState;
  page262145: DbLayoutPageState;
  /** 文件当前实际使用的逻辑页布局。 */
  layout: DbLayoutKind;
  /** 是否建议走「布局迁移」。 */
  needsMigration: boolean;
  /** 给用户看的一句话。 */
  summary: string;
}

/** 从文件头判断 QQ 自定义头长度（与 offset VFS / scanBadPages 同一套判定）。 */
export function detectHeaderOffset(header: Buffer): number {
  const magic = header.subarray(32, 40);
  return magic.equals(Buffer.from('QQ_NT DB')) || magic.equals(Buffer.from('Guild DB')) ? 1024 : 0;
}

function readPageState(fd: number, offset: number, fileBytes: number): DbLayoutPageState {
  if (offset < 0 || offset + LAYOUT_PAGE_SIZE > fileBytes) return 'missing';
  const page = Buffer.allocUnsafe(LAYOUT_PAGE_SIZE);
  const read = readSync(fd, page, 0, LAYOUT_PAGE_SIZE, offset);
  if (read !== LAYOUT_PAGE_SIZE) return 'missing';
  for (let index = 0; index < page.length; index += 1) {
    if (page[index] !== 0) return 'data';
  }
  return 'zero';
}

/**
 * 两个页状态 → 结论。
 *
 * - `262144` 零、`262145` 有数据 → QQ 布局，正常；
 * - `262144` 有数据、`262145` 零 → standard 布局，旧版误修复，建议迁移；
 * - 其它（都零 / 都缺失 / 都有数据）→ 判不了，不提示迁移。
 */
export function classifyLayoutPages(
  page262144: DbLayoutPageState,
  page262145: DbLayoutPageState,
): { layout: DbLayoutKind; needsMigration: boolean } {
  if (page262144 === 'zero' && page262145 === 'data') {
    return { layout: 'qq', needsMigration: false };
  }
  if (page262144 === 'data' && page262145 === 'zero') {
    return { layout: 'standard', needsMigration: true };
  }
  return { layout: 'unknown', needsMigration: false };
}

/** 读一个库文件，按用户指定的两个判据给出布局结论。 */
export function probeDbLayout(dbPath: string): DbLayoutProbe {
  const fileBytes = statSync(dbPath).size;
  const fd = openSync(dbPath, 'r');
  try {
    const header = Buffer.alloc(1024);
    const headerRead = readSync(fd, header, 0, Math.min(header.length, fileBytes), 0);
    const headerOffset = headerRead >= 40 ? detectHeaderOffset(header) : 0;
    const pageOffset = (page: number): number => headerOffset + (page - 1) * LAYOUT_PAGE_SIZE;
    const page262144 = readPageState(fd, pageOffset(QQ_RESERVED_PAGE), fileBytes);
    const page262145 = readPageState(fd, pageOffset(STANDARD_RESERVED_PAGE), fileBytes);
    const pageCount = Math.max(0, Math.floor((fileBytes - headerOffset) / LAYOUT_PAGE_SIZE));

    if (fileBytes <= LAYOUT_MIN_BYTES) {
      return {
        dbPath,
        fileBytes,
        headerOffset,
        pageSize: LAYOUT_PAGE_SIZE,
        pageCount,
        page262144,
        page262145,
        layout: 'unknown',
        needsMigration: false,
        summary: '文件不超过 1 GiB，不需要检查页布局。',
      };
    }

    const { layout, needsMigration } = classifyLayoutPages(page262144, page262145);
    const summary =
      layout === 'standard'
        ? '检测到 standard 页布局（第 262144 页有数据、第 262145 页是保留页）。这通常是旧版误修复留下的，建议优先做布局迁移。'
        : layout === 'qq'
          ? '页布局是 QQ 布局（第 262144 页是保留页），不需要迁移。'
          : '第 262144 / 262145 页的状态不足以判断页布局，不提示迁移。';
    return {
      dbPath,
      fileBytes,
      headerOffset,
      pageSize: LAYOUT_PAGE_SIZE,
      pageCount,
      page262144,
      page262145,
      layout,
      needsMigration,
      summary,
    };
  } finally {
    closeSync(fd);
  }
}
