/**
 * 导出「消息补全」— 扫描会话的 seq 空窗，按从新到旧（seq 降序）并发把缺失
 * 消息从 QQ 服务端拉进本机漫游缓存（与聊天页「缺失消息」共用 RoamMsgCacheDb，
 * 之前聊天页已经拉过的窗口这里直接命中缓存、不再联网）。
 *
 * 拉取能力桥接 {@link GapHistoryService}（`@weq/protocol` 的 SsoGetGroupMsg /
 * SsoGetC2cMsg，单窗最多 30 条，拉到的消息以渲染视图写回漫游缓存）。扫描从
 * 最新的空窗开始向更旧的方向并发推进，连续 {@link MAX_EMPTY_WINDOWS} 个请求
 * 没有返回一条消息即判定更早的消息全部过期、提前结束；单窗耗时超过
 * {@link RATE_LIMIT_MS} 视为被限流，通过 onRateLimited 上报（前端 toast 提示
 * 耐心等待）。
 *
 * 时序：本阶段在导出流水线最前面执行，之后的消息导出 / 媒体扫描会从漫游缓存
 * 合并这些补全消息，因此它们同样参与媒体补全 / 文件 / 视频下载。
 *
 * 时间范围：导出选了时间范围时，seq 扫描只取时间窗内的本地 seq（
 * {@link MessageBackfillOptions.listSeqWindow} 由 MsgService 按 sendTime 收窄），
 * 空窗也以窗界锚点 below/above 收窄——补全只拉窗内的缺失消息，不会把整段
 * 历史拉回来再在导出时丢弃。
 */

import type { GapFetchedMessage, GapFetchResult } from '../gap_history';

/** 服务端单次最多返回约 30 条（与聊天页 GapHistoryService 同一契约）。 */
const SERVER_MAX_WINDOW = 30;
/** 默认并发请求数。 */
const DEFAULT_CONCURRENCY = 8;
/** 连续空窗阈值：超过即判定更早消息全部过期。 */
const DEFAULT_MAX_EMPTY_WINDOWS = 10;
/** 单窗耗时超过该毫秒数视为被限流。 */
const DEFAULT_RATE_LIMIT_MS = 3000;

/** 补全能力（由 app 注入，桥接聊天页的 GapHistoryService）。 */
export interface MessageBackfillDeps {
  /** 读本机漫游缓存一段 [startSeq, endSeq] 的缺失消息（不联网）。 */
  cached(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
  ): Promise<GapFetchedMessage[]>;
  /** 拉取一个最多 30-seq 的服务端窗口：先查缓存（命中不联网），拉到的写回缓存。 */
  fetch(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
  ): Promise<GapFetchResult>;
}

/**
 * 会话 seq 窗口：时间窗内的本地 seq + 窗界锚点，供补全只拉窗内空窗。
 * 形状与 `@weq/db` 的 `SeqWindow` 一致（MsgService 直接透传）。
 */
export interface BackfillSeqWindow {
  /** sendTime ∈ [range.start, range.end] 的本地 seq（40003 > 0），新→旧。 */
  seqs: bigint[];
  /** sendTime < range.start 的最新本地 seq；无下界或无此类消息时为 null。 */
  below: bigint | null;
  /** sendTime > range.end 的最旧本地 seq；无上界或无此类消息时为 null。 */
  above: bigint | null;
}

export interface MessageBackfillOptions {
  kind: 'c2c' | 'group';
  /** 群号或私聊对方 uid。 */
  conv: string;
  /**
   * 会话 seq 窗口来源（MsgService 的索引扫描，按导出时间范围收窄）：seqs
   * 只含时间窗内的本地 seq，below/above 为窗界锚点（无时间范围时均为 null）。
   */
  listSeqWindow: () => Promise<BackfillSeqWindow>;
  fetch: MessageBackfillDeps['fetch'];
  /** 并发请求数（默认 8，建议 5-10）。 */
  concurrency?: number;
  /** 连续空窗阈值（默认 10）。 */
  maxEmptyWindows?: number;
  /** 单窗限流阈值毫秒（默认 3000）。 */
  rateLimitMs?: number;
  /** 取消信号（任务暂停 / 取消）。 */
  signal?: AbortSignal;
  /** 扫描出全部空窗后回调（totalWindowSeqs = 待拉取的空窗 seq 总量，用作进度分母）。 */
  onPlan?: (totalWindowSeqs: number) => void;
  /** 每个窗口完成后回调（fetched = 该窗新拉取条数，缓存命中为 0；windowSeqs = 该窗 seq 数）。 */
  onWindow?: (fetched: number, windowSeqs: number) => void;
  /** 单个窗口拉取抛异常时回调（不炸整个补全；该窗按「非空」结算避免误判过期）。 */
  onWindowError?: (windowSeqs: number, message: string) => void;
  /** 出现一次慢请求（可能被限流）时回调（前端 toast）。 */
  onRateLimited?: () => void;
}

export interface MessageBackfillSummary {
  /** 本次新拉取到的消息条数（不含缓存命中）。 */
  fetched: number;
  /** 实际发出的请求数（缓存全命中的窗口不计数）。 */
  requests: number;
  /** 服务端返回空的消息窗数量。 */
  emptyWindows: number;
  /** 限流（慢请求）提示次数。 */
  rateLimited: number;
  /** 拉取时抛异常（非 ok:false 正常错误路径）的窗口数。 */
  windowErrors: number;
  /** 是否因为连续空窗提前结束（更早消息判定全部过期）。 */
  stoppedByEmpty: boolean;
  /** 是否因为离线 / 拉取失败提前结束。 */
  stoppedByError: boolean;
  /** 全部空窗的 seq 总量（进度分母；提前结束时空窗未拉完）。 */
  totalWindowSeqs: number;
}

/**
 * 从「时间窗内全部 seq 空窗」生成 30-seq 拉取窗口，按从新到旧排序。
 *
 * 空窗 = 相邻窗内 seq 之间的跳号区间 + 最旧窗内 seq 之下的区间。底部区间只
 * 从锚点 below（sendTime < range.start 的最新本地 seq）之上开始拉——其下消息
 * 必然早于时间窗，不再整段拉 1..minSeq-1；无锚点（无下界）时保持原语义
 * 1..minSeq-1（漫游覆盖边界外，靠连续空窗收尾）。时间窗内没有任何本地消息
 * 时，退化为以 below/above 为界的整段区间（窗内缺失消息只能整段拉回）。
 * 每个区间从最新端向下切成 30-seq 一段，整体保持 seq 降序。
 */
export function buildBackfillWindows(
  seqsDesc: bigint[],
  opts: { below?: bigint | null; above?: bigint | null } = {},
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  const gaps: Array<{ start: number; end: number }> = [];
  if (seqsDesc.length === 0) {
    // 时间窗内没有任何本地消息：锚点 (below, above) 之间整段拉取。
    const below = opts.below ?? null;
    const above = opts.above ?? null;
    if (below != null && above != null && above - below > 1n) {
      gaps.push({ start: Number(below + 1n), end: Number(above - 1n) });
    }
  } else {
    const minSeq = seqsDesc[seqsDesc.length - 1]!;
    // 最旧窗内本地消息之下：从锚点 below 之上开始（其下消息必然早于时间窗）。
    const lo = opts.below != null ? opts.below + 1n : 1n;
    if (minSeq > lo) gaps.push({ start: Number(lo), end: Number(minSeq - 1n) });
    for (let i = 0; i < seqsDesc.length - 1; i += 1) {
      const newer = seqsDesc[i]!;
      const older = seqsDesc[i + 1]!;
      if (newer - older > 1n) gaps.push({ start: Number(older + 1n), end: Number(newer - 1n) });
    }
  }
  gaps.sort((a, b) => b.end - a.end);
  for (const gap of gaps) {
    for (let end = gap.end; end >= gap.start; end -= SERVER_MAX_WINDOW) {
      windows.push({ start: Math.max(gap.start, end - SERVER_MAX_WINDOW + 1), end });
    }
  }
  return windows;
}

/**
 * 并发向前推进拉取，直到连续空窗阈值或全部窗口拉完。
 *
 * 结果按扫描顺序（新→旧）提交：并发下先完成的窗口先进结果槽，只有某个位置
 * 及其之前的窗口全部完成后才按序结算，这样「连续 N 次空窗」的判定与串行扫描
 * 语义一致。结算到阈值即停止派发新请求（已在途的让其自然结束）。
 */
export async function backfillConversationMessages(
  opts: MessageBackfillOptions,
): Promise<MessageBackfillSummary> {
  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? DEFAULT_CONCURRENCY));
  const maxEmpty = Math.max(1, opts.maxEmptyWindows ?? DEFAULT_MAX_EMPTY_WINDOWS);
  const rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;

  const win = await opts.listSeqWindow();
  const seqsDesc = win.seqs.filter((s) => s > 0n);
  const windows = buildBackfillWindows(seqsDesc, { below: win.below, above: win.above });
  const totalWindowSeqs = windows.reduce((sum, w) => sum + (w.end - w.start + 1), 0);
  const summary: MessageBackfillSummary = {
    fetched: 0,
    requests: 0,
    emptyWindows: 0,
    rateLimited: 0,
    windowErrors: 0,
    stoppedByEmpty: false,
    stoppedByError: false,
    totalWindowSeqs,
  };
  if (windows.length === 0) return summary;
  try {
    opts.onPlan?.(totalWindowSeqs);
  } catch {
    // UI 回调异常不能打断补全。
  }

  // null = 未完成；true = 该窗非空；false = 该窗服务端无消息。
  const results = new Array<boolean | null>(windows.length).fill(null);
  let nextIssue = 0;
  let nextCommit = 0;
  let consecutiveEmpty = 0;
  let stopped = false;
  let rateLimitedNotified = false;

  const workers = Array.from({ length: Math.min(concurrency, windows.length) }, async () => {
    for (;;) {
      if (stopped || opts.signal?.aborted) return;
      const idx = nextIssue;
      nextIssue += 1;
      if (idx >= windows.length) return;
      const window = windows[idx]!;
      const windowSeqs = window.end - window.start + 1;
      const startedAt = Date.now();
      let res: GapFetchResult | null = null;
      try {
        res = await opts.fetch(opts.kind, opts.conv, window.start, window.end);
      } catch (e) {
        // 单窗异常不炸整个补全：按「非空」结算（避免连续空窗误判为过期），
        // 其余窗口继续；失败窗口数进 summary，供任务阶段标注「部分失败」。
        summary.windowErrors += 1;
        results[idx] = true;
        try {
          opts.onWindowError?.(windowSeqs, e instanceof Error ? e.message : String(e));
        } catch {
          // UI 回调异常同样不能打断补全。
        }
      }
      if (res) {
        const elapsed = Date.now() - startedAt;
        summary.requests += 1;
        if (elapsed > rateLimitMs) {
          summary.rateLimited += 1;
          if (!rateLimitedNotified) {
            rateLimitedNotified = true;
            try {
              opts.onRateLimited?.();
            } catch {
              // UI 回调异常不能打断补全。
            }
          }
        }
        if (!res.ok) {
          // 离线 / 窗口错误：不作为空窗（避免误判过期）；离线则整体提前结束。
          if (res.reason === 'offline') {
            stopped = true;
            summary.stoppedByError = true;
          } else {
            results[idx] = true; // 拉取失败按非空处理，避免被误判为「过期」。
          }
        } else {
          const nonEmpty = res.messages.length > 0;
          summary.fetched += res.fetched;
          if (!nonEmpty) summary.emptyWindows += 1;
          results[idx] = nonEmpty;
          try {
            opts.onWindow?.(res.fetched, windowSeqs);
          } catch {
            // UI 回调异常不能打断补全。
          }
        }
      }
      // 按扫描顺序结算已完成的窗口。
      while (nextCommit < windows.length && results[nextCommit] !== null) {
        const nonEmpty = results[nextCommit]!;
        nextCommit += 1;
        if (nonEmpty) {
          consecutiveEmpty = 0;
        } else {
          consecutiveEmpty += 1;
          if (consecutiveEmpty >= maxEmpty) {
            stopped = true;
            summary.stoppedByEmpty = true;
            break;
          }
        }
      }
    }
  });
  await Promise.all(workers);
  return summary;
}
