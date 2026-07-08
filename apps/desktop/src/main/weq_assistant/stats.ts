/**
 * WeQ 助手「群数据周报」推文 —— 快照 + 缓存层。
 *
 * 一篇「推文」是一张**存下来的快照**，不是每次点开才现算的小程序：我们把「我等级最
 * 高的那个群」的一整套聊天统计（发言排行 / 活跃时段 / 每日热力图 / 词云 + 概览）**一次
 * 算好落盘**成 JSON，QQ 打开 `/p/stats` 时只读这份快照渲染，绝不重算。
 *
 * 数据流：
 *   app_context.computeAndCacheWeqStats()  // 后台、账号打开时触发、自然日过期才重算
 *     └─ groupInfo.pickTopSelfLevelGroup() + getGroupStatsReport()
 *          └─ saveStatsToDisk(cachePath)  +  setWeqStats(snapshot)   // 落盘 + 进内存
 *   server.ts  GET /p/stats  →  getWeqStats()  →  renderStatsPageHtml()   // 只读渲染
 *
 * 内存快照镜像 theme.ts 的做法：主进程渲染页面读内存即可，落盘只是为了跨重启不必重算。
 * 首次没缓存时页面回落到「生成中」占位（见 stats_page.ts）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GroupInfoService, GroupStatsReport } from '@weq/service';

/** 一篇「群数据周报」推文的完整快照（落盘 / 内存同构）。 */
export interface WeqStatsReport {
  /** 生成时刻（Unix ms）。用于「自然日缓存」判定 + 页面上的生成时间。 */
  generatedAt: number;
  /** 快照所属账号 uin —— 换账号时用来判定缓存归属，避免串号。 */
  uin: string;
  /** 目标群 + 我在该群的等级（遍历所有群取等级最高者）。 */
  group: {
    code: string;
    name: string;
    memberCount: number;
    myLevel: number;
  };
  /** 该群的一整套统计聚合（单次全表扫描算出）。 */
  stats: GroupStatsReport;
}

// ── 内存快照 ──────────────────────────────────────────────────────────────

let current: WeqStatsReport | null = null;

/** 当前统计快照（渲染 `/p/stats` 与 `/cover/stats` 时读它）。 */
export function getWeqStats(): WeqStatsReport | null {
  return current;
}

/** 设置内存快照（app_context 算完 / 启动读盘后调用）。传 null 清空（如切账号）。 */
export function setWeqStats(next: WeqStatsReport | null): void {
  current = next;
}

// ── 落盘缓存 ──────────────────────────────────────────────────────────────

/** 读盘快照；文件缺失 / 损坏 / 结构不符都回 null（当作没缓存）。 */
export function loadStatsFromDisk(path: string): WeqStatsReport | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WeqStatsReport;
    if (
      !parsed ||
      typeof parsed.generatedAt !== 'number' ||
      !parsed.group ||
      typeof parsed.group.code !== 'string' ||
      !parsed.stats ||
      !parsed.stats.totals
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 落盘快照（懒建父目录）。 */
export function saveStatsToDisk(path: string, report: WeqStatsReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report), 'utf-8');
}

/**
 * 快照是否仍「新鲜」：同一账号 + 同一自然日（本地时区）生成的即算新鲜，否则需后台重算。
 * 「推文」是每日一更的日报语义，用自然日而非固定 TTL，避免半夜跨天却因不足 24h 不刷新。
 */
export function isStatsFresh(report: WeqStatsReport | null, uin: string): boolean {
  if (!report || report.uin !== uin) return false;
  const a = new Date(report.generatedAt);
  const b = new Date();
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 统计快照的落盘路径（按 uin 区分账号，避免串号）。 */
export function statsCachePath(cacheDir: string, uin: string): string {
  return join(cacheDir, `stats-${uin}.json`);
}

// ── 编排：读盘 → （必要时）重算 → 落盘 + 进内存 ──────────────────────────────

/**
 * 确保内存里有尽可能新的统计快照：
 *   1) 先把盘上缓存（同账号）灌进内存 —— 哪怕已过期，也先让页面有东西看；
 *   2) 若已是「今日新鲜」则到此为止，不重算；
 *   3) 否则遍历群聊挑「我等级最高的群」→ 单次扫描聚合统计 → 落盘 + 替换内存快照。
 *
 * best-effort：任何失败都只返回当前内存快照（可能为 null），由调用方以 fire-and-forget
 * 方式调用并吞掉异常。整段是「推文的存储/缓存逻辑」——页面永远只读快照，绝不现算。
 */
export async function refreshWeqStats(
  groupInfo: GroupInfoService,
  uin: string,
  cachePath: string,
): Promise<WeqStatsReport | null> {
  // 1) 盘 → 内存（仅认同账号快照）。
  const cached = loadStatsFromDisk(cachePath);
  if (cached && cached.uin === uin) setWeqStats(cached);

  // 2) 今日已新鲜 → 直接用缓存，跳过昂贵的全表扫描。
  if (isStatsFresh(cached, uin)) return cached;

  // 3) 重算。
  const top = await groupInfo.pickTopSelfLevelGroup();
  if (!top) return getWeqStats(); // 没有任何群 / 查不到自己的成员等级
  const stats = await groupInfo.getGroupStatsReport(BigInt(top.code));
  const report: WeqStatsReport = {
    generatedAt: Date.now(),
    uin,
    group: { code: top.code, name: top.name, memberCount: top.memberCount, myLevel: top.myLevel },
    stats,
  };
  saveStatsToDisk(cachePath, report);
  setWeqStats(report);
  return report;
}
