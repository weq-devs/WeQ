/**
 * Stage `ocrfilter` + `ocr` —— 导出时自动识别图片文字。
 *
 * 与语音转写（`media_export` 的 `transcribeFoundVoices`）同构：和消息导出**并发**跑，
 * 结果写成 bundle 根目录的 `ocr.json`，消息文件早在落盘时就埋好了锚点，最后由
 * `ocr_rewrite` 把文件名字换成识别出的文字。
 *
 * 三步流水线：
 *
 *   1. **预筛选**（`ocrfilter`）：先用最省的检测模型判断「这张图里有没有文字」，
 *      风景 / 人像这类直接跳过，不进识别模型。强烈建议开 —— 识别是整个导出里最慢的
 *      一步。没注入筛图模型就不筛（全部送识别），筛图失败的图按「有文字」处理
 *      （宁可多跑一次，也不静默丢文字）。
 *   2. **在线优先**（可选，`ocr`）：QQ 在线时把图交给 QQ 服务端的图片 OCR
 *      （OIDB 0xe07_0，服务端自己去取图）。**从新的往旧的试** —— 聊天图片的 CDN
 *      直链只有约 9 天寿命，越新的越可能还取得到。并发发请求，**连续失败
 *      {@link OCR_ONLINE_FAILURE_LIMIT} 张就宣告在线那条腿彻底不行**，剩下的全部
 *      回退本地模型（服务端取不到图往往是整批一起过期，继续试只是白等）。
 *   3. **本地模型兜底**（`ocr`）：在线没拿到的（含被放弃的）交给本地 PP-OCR 跑，
 *      前提是这张图的本体在这台机器上。
 *
 * 两条腿都没有的图直接算失败并记进阶段失败列表（UI 的失败详情灯箱）。
 *
 * 非本地的图片也可以走在线（服务端自己去 CDN 取），所以预筛选只对**本机有本体**的图
 * 生效；本机没有、又还没过期的图会直接送在线（无法预筛，日志里单独报个数）。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OcrBlock } from '@weq/protocol';
import type { MediaRef, MediaScanResult } from './media_scan';
import type { MediaFailure, MediaStageResult, StageLog, StageProgress } from './media_export';

/** 本阶段的产物文件名（bundle 根目录）。 */
export const OCR_RESULTS_FILE = 'ocr.json';

/** 在线识别连续失败多少张就放弃在线那条腿（默认）。 */
export const OCR_ONLINE_FAILURE_LIMIT = 10;

/** 一次图片识别的产出（两条腿共用同一形状）。 */
export interface OcrImageOutcome {
  ok: boolean;
  /** 识别出的文字（多行用 `\n` 连接）。 */
  text?: string;
  /** 逐行文字 + 像素坐标框（与在线版同构，见 `OcrImage` 协议）。 */
  blocks?: OcrBlock[];
  /** 被识别的图宽 / 高（像素，坐标框与它同系）。 */
  width?: number;
  height?: number;
  elapsedMs?: number;
  /** 失败原因（给人看的中文短句）。 */
  error?: string;
}

/**
 * 本地模型识别一张图（app 注入 —— onnxruntime 是原生库，住在 Electron 主进程）。
 * 入参是本机上那张图的绝对路径。
 */
export type OcrImageFn = (imagePath: string) => Promise<OcrImageOutcome>;

/** 筛图结果：只回答「这张图里有没有文字」。 */
export interface OcrFilterOutcome {
  ok: boolean;
  /** 有文字吗（`ok: false` 时忽略）。 */
  hasText?: boolean;
  /** 检测到的文字框个数（日志用）。 */
  boxes?: number;
  elapsedMs?: number;
  error?: string;
  /**
   * 筛图这条腿**根本不可用**（模型被删了 / 没选）—— 与「这张图筛图失败」不同：
   * 前者应当整体跳过预筛选，后者按「有文字」处理继续送识别。
   */
  unavailable?: boolean;
}

/**
 * 筛图（app 注入）：只加载最省的检测模型，输入同样是本机图片路径。
 * 不注入 = 不预筛选，每张图都送识别模型。
 */
export type OcrFilterFn = (imagePath: string) => Promise<OcrFilterOutcome>;

/** 一次在线识别（QQ 服务端 0xe07_0）的请求。 */
export interface OcrOnlineRequest {
  /** 图片文件名 —— 结果按它回填。 */
  fileName: string;
  /** CDN download token（元素 45503）；app 侧据此现签 CDN 直链。 */
  fileToken: string;
  /** 会话场景：私聊图 / 群图取不同的 rkey。 */
  peerType: 'c2c' | 'group';
  /** 图片宽高：随行元数据，也是回包坐标系的基准。 */
  width: number;
  height: number;
  /** 图片 md5（32 位小写 hex，可缺 —— 服务端不校验）。 */
  md5?: string;
  /** 图片字节数（可选）。 */
  fileSize?: number;
}

/**
 * 在线识别一张图（app 注入：OIDB 0xe07_0 + rkey 缓存）。并发由本模块的批量执行器
 * 控制，注入的实现只管发一张、回一张。
 */
export type OcrOnlineImageFn = (req: OcrOnlineRequest) => Promise<OcrImageOutcome>;

/** `ocr.json` 里一条记录。 */
export interface OcrResultEntry {
  /** 识别出的文字（多行用 `\n` 连接）。 */
  text: string;
  /** 哪条腿出的结果。 */
  source: 'oidb' | 'local';
  /** 识别模型 id（本地那条腿；在线为空）。 */
  modelId?: string;
  width?: number;
  height?: number;
  elapsedMs?: number;
  /** 逐行文字 + 像素坐标框（坐标即 `width × height` 那张图上的像素）。 */
  blocks?: OcrBlock[];
}

/** 一次批量执行里单个项的结果。 */
export interface BatchOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** 批量执行的结果（成功 / 失败 / 因连续失败被放弃的项）。 */
export interface BatchRunResult<TIn, TOut> {
  results: Array<{ item: TIn; value: TOut }>;
  failures: Array<{ item: TIn; error: string }>;
  /** 因连续失败达到上限而**没有被尝试**的项。 */
  abandoned: TIn[];
}

/**
 * 并发跑一批任务，**连续失败 `failureLimit` 次就整体放弃**：剩余的项原样进
 * `abandoned`，由调用方决定怎么兜底（这里是回退本地模型）。
 *
 * 计数按「完成的顺序」算 —— 成功一次把连败清零；已经在飞的请求照常等它落地
 * （它可能正好成功）。并发度 1 时就是字面意义的「连续失败」。
 */
export async function runBatchWithFailureLimit<TIn, TOut>(
  items: readonly TIn[],
  worker: (item: TIn) => Promise<BatchOutcome<TOut>>,
  opts: {
    concurrency?: number;
    failureLimit?: number;
    /** 放弃时的回调（日志用；`remaining` = 放弃时还没试的项数）。 */
    onGiveUp?: (streak: number, remaining: number) => void;
  } = {},
): Promise<BatchRunResult<TIn, TOut>> {
  const limit = Math.max(1, opts.failureLimit ?? OCR_ONLINE_FAILURE_LIMIT);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, items.length || 1));
  const results: BatchRunResult<TIn, TOut>['results'] = [];
  const failures: BatchRunResult<TIn, TOut>['failures'] = [];
  const attempted = new Set<number>();
  let next = 0;
  let streak = 0;
  let gaveUp = false;

  const run = async (): Promise<void> => {
    for (;;) {
      if (gaveUp) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index]!;
      attempted.add(index);
      let outcome: BatchOutcome<TOut>;
      try {
        outcome = await worker(item);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (outcome.ok) {
        streak = 0;
        results.push({ item, value: outcome.value as TOut });
        continue;
      }
      streak += 1;
      failures.push({ item, error: outcome.error ?? '未知错误' });
      if (streak >= limit && !gaveUp) {
        gaveUp = true;
        const remaining = items.length - attempted.size;
        opts.onGiveUp?.(streak, Math.max(0, remaining));
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, run));
  const abandoned = items.filter((_item, index) => !attempted.has(index));
  return { results, failures, abandoned };
}

/** `ocrFoundImages` 的可注入依赖 + 进度 / 日志回调。 */
export interface OcrStageDeps {
  /** 在线识别一张图（缺省或未注入 = 纯本地）。 */
  online?: OcrOnlineImageFn;
  /** 在线并发（默认 5）。 */
  onlineConcurrency?: number;
  /** 在线连续失败上限（默认 {@link OCR_ONLINE_FAILURE_LIMIT}）。 */
  onlineFailureLimit?: number;
  /** 本地模型识别一张图（缺省 = 在线没拿到的只能失败）。 */
  local?: OcrImageFn;
  /** 本地识别并发（默认 2 —— 每次都要 fork 一个原生推理进程，CPU 吃满）。 */
  localConcurrency?: number;
  /** 筛图（缺省 = 不筛）。 */
  filter?: OcrFilterFn;
  /** 筛图并发（默认 4）。 */
  filterConcurrency?: number;
  /** 筛图阶段进度（`ocrfilter` 那条进度条）。 */
  onFilterProgress?: StageProgress;
  /** 识别阶段进度（`ocr` 那条进度条）。 */
  onProgress?: StageProgress;
  onLog?: StageLog;
}

/** 本阶段的产出统计。 */
export interface OcrExportSummary {
  /** `ocr.json` 的绝对路径。 */
  filePath: string;
  /** 送进识别（含在线）的图片张数 —— 已过筛。 */
  total: number;
  ok: number;
  failed: number;
  /** 在线 / 本地各自出了多少张。 */
  online: number;
  local: number;
  /** 本机没有本体、只能送在线的张数。 */
  onlineOnly: number;
  /** 筛图统计；没开筛图时为 null。 */
  filter: {
    scanned: number;
    withText: number;
    skipped: number;
    failed: number;
    /** 筛图模型中途不可用 → 本次没筛（全部送识别）。 */
    unavailable?: boolean;
  } | null;
  /** 识别阶段矩阵（`MediaStageResult`，供任务阶段直接用）。 */
  stage: MediaStageResult;
  /** `fileName → 结果`（与写进 `ocr.json` 的 `images` 段一致）。 */
  results: Record<string, OcrResultEntry>;
}

/** 识别出的文字：优先用注入实现给的 `text`，只给了框就按顺序拼。 */
function textOf(outcome: OcrImageOutcome): string {
  const text = outcome.text ?? outcome.blocks?.map((b) => b.text).join('\n') ?? '';
  return text.trim();
}

/** 并发跑一批（本模块内部用；策略见的批量执行器，这里只要并发不要连败放弃）。 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = i;
      i += 1;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * 只打前几条、之后按批汇总的日志器 —— 几千张图逐条刷屏会把任务日志挤爆
 * （环形缓冲 400 行），用户反而看不到关键信息。
 */
function makeQuietLog(onLog?: StageLog, keepFirst = 20, every = 100) {
  let shown = 0;
  let suppressed = 0;
  return {
    log(text: string, level?: 'info' | 'warn' | 'error'): void {
      if (shown < keepFirst) {
        shown += 1;
        onLog?.(text, level);
        return;
      }
      suppressed += 1;
      if (suppressed % every === 0)
        onLog?.(`${text}（同类日志已省略 ${suppressed - 1} 条）`, level);
    },
    /** 被省略的条数（收尾时补一句）。 */
    get hidden(): number {
      return suppressed;
    },
  };
}

/** 一张图能不能走在线那条腿（要 fileToken + 宽高 + 会话信息）。 */
function canGoOnline(ref: MediaRef): boolean {
  return Boolean(
    ref.fileToken && ref.ocr && ref.ocr.width > 0 && ref.ocr.height > 0 && ref.ocr.peerUin,
  );
}

/** 由元素信息拼一条在线识别请求。 */
function toOnlineRequest(ref: MediaRef): OcrOnlineRequest {
  const o = ref.ocr!;
  return {
    fileName: ref.fileName,
    fileToken: ref.fileToken,
    peerType: o.isGroup ? 'group' : 'c2c',
    width: o.width,
    height: o.height,
    md5: o.md5 || undefined,
    fileSize: o.fileSize || undefined,
  };
}

/** 一条失败记录（进阶段失败列表，UI 的失败详情灯箱读它）。 */
function pushFailure(out: MediaFailure[], fileName: string, error: string): void {
  out.push({ stage: 'ocr', fileName, error });
  if (out.length > 200) out.splice(0, out.length - 200);
}

/**
 * 跑一遍「筛图 → 在线优先 → 本地兜底」，把结果写进 `<bundleDir>/ocr.json`。
 *
 * 只有本机存在本体的图片参与（预筛选要读图）；本机没有、又还没过期的图如果在线那条
 * 腿可用，也一并送在线（服务端自己去取）。两条腿都没有的图算失败。
 */
export async function ocrFoundImages(
  scan: MediaScanResult,
  bundleDir: string,
  deps: OcrStageDeps,
): Promise<OcrExportSummary> {
  const onLog = deps.onLog;
  const quiet = makeQuietLog(onLog);
  const results: Record<string, OcrResultEntry> = {};

  // ---- 候选：本机有本体的图（预筛要用）+ 本机没有但还能下载的图（只能走在线）----
  const localCandidates = scan.found.filter((ref) => ref.kind === 'pic' && ref.path);
  const onlineOnlyRefs = deps.online
    ? scan.downloadList.filter((ref) => ref.kind === 'pic' && canGoOnline(ref))
    : [];
  // 新 → 旧：在线那条腿从最近的消息开始试（CDN 直链只有约 9 天寿命）。
  const byNewest = (a: MediaRef, b: MediaRef): number => b.sendTime - a.sendTime;
  localCandidates.sort(byNewest);
  onlineOnlyRefs.sort(byNewest);

  if (localCandidates.length + onlineOnlyRefs.length === 0) {
    const summary = writeArtifact(bundleDir, results, {
      total: 0,
      ok: 0,
      failed: 0,
      online: 0,
      local: 0,
      onlineOnly: 0,
      filter: null,
    });
    onLog?.('没有需要识别的图片（跳过）');
    return summary;
  }
  onLog?.(
    `图片文字识别：候选 ${localCandidates.length} 张本地图片` +
      (onlineOnlyRefs.length > 0
        ? ` · 另有 ${onlineOnlyRefs.length} 张本机没有本体，直接送在线`
        : ''),
  );

  // ---- 1. 预筛选：先甩掉没有文字的图 ----
  let items = localCandidates;
  let filter: OcrExportSummary['filter'] = null;
  if (deps.filter) {
    const filterFn = deps.filter;
    filter = { scanned: 0, withText: 0, skipped: 0, failed: 0 };
    const kept: MediaRef[] = [];
    let unavailable = false;
    let done = 0;
    deps.onFilterProgress?.(0, localCandidates.length);
    await mapLimit(localCandidates, deps.filterConcurrency ?? 4, async (ref) => {
      try {
        const r = await filterFn(ref.path!);
        if (!r.ok && r.unavailable) {
          // 筛图模型被删了 / 没选：整体跳过预筛选（后面的图不再问它），免得刷一堆
          // 同一条告警。已经在飞的几个照旧按「有文字」处理。
          if (!unavailable) {
            unavailable = true;
            onLog?.(`筛图模型不可用（${r.error ?? '未知原因'}），本次跳过预筛选`, 'warn');
          }
          kept.push(ref);
        } else if (!r.ok) {
          // 筛图失败按「有文字」处理：宁可多跑一次识别，也不静默丢文字。
          filter!.failed += 1;
          kept.push(ref);
          quiet.log(`筛图失败 ${ref.fileName}：${r.error ?? '未知错误'}（按有文字处理）`, 'warn');
        } else if (r.hasText) {
          filter!.withText += 1;
          kept.push(ref);
        } else {
          filter!.skipped += 1;
          quiet.log(`跳过 ${ref.fileName}（没检测到文字）`);
        }
      } catch (e) {
        filter!.failed += 1;
        kept.push(ref);
        quiet.log(
          `筛图异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}（按有文字处理）`,
          'warn',
        );
      } finally {
        filter!.scanned += 1;
        done += 1;
        deps.onFilterProgress?.(done, localCandidates.length);
      }
    });
    items = kept;
    if (unavailable) filter.unavailable = true;
    else
      onLog?.(
        `预筛选完成：${filter.scanned} 张里 ${filter.withText} 张有文字，跳过 ${filter.skipped} 张` +
          (filter.failed > 0 ? `（${filter.failed} 张筛图失败，按有文字处理）` : '') +
          (quiet.hidden > 0 ? `（省略 ${quiet.hidden} 条同类日志）` : ''),
      );
  } else if (localCandidates.length > 0) {
    onLog?.('未启用预筛选（没下载筛图模型），全部图片都会送识别，会慢很多', 'warn');
  }

  // 在线那条腿的候选：过了筛的本地图（有在线信息）+ 本机没本体的图。
  const onlineQueue: MediaRef[] = [...items.filter(canGoOnline), ...onlineOnlyRefs].sort(byNewest);
  const ocrQueue: MediaRef[] = [...items, ...onlineOnlyRefs];

  // ---- 2. 在线优先（从新到旧，连续失败即放弃）----
  const onlineFn = deps.online;
  let onlineCount = 0;
  if (onlineFn && onlineQueue.length > 0) {
    const concurrency = deps.onlineConcurrency ?? 5;
    onLog?.(
      `在线识别：${onlineQueue.length} 张（并发 ${concurrency}，连续失败 ` +
        `${deps.onlineFailureLimit ?? OCR_ONLINE_FAILURE_LIMIT} 张即放弃在线）`,
    );
    const batch = await runBatchWithFailureLimit(
      onlineQueue,
      async (ref) => {
        try {
          const r = await onlineFn(toOnlineRequest(ref));
          return r.ok ? { ok: true as const, value: r } : { ok: false as const, error: r.error };
        } catch (e) {
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
        }
      },
      {
        concurrency,
        failureLimit: deps.onlineFailureLimit ?? OCR_ONLINE_FAILURE_LIMIT,
        onGiveUp: (streak, remaining) =>
          onLog?.(
            `在线识别连续失败 ${streak} 张，判定在线那条腿不可用，放弃剩余 ${remaining} 张` +
              (deps.local ? '（有本地模型，全部回退本地）' : '（没有本地模型，这些图会记为失败）'),
            'warn',
          ),
      },
    );
    for (const { item, value } of batch.results) {
      const text = textOf(value);
      if (!text) {
        // 在线说成功但一个字都没识别出来：如实记一条空结果，不再送本地（图能取到、
        // 服务端也认过一遍了，本地多半同样是空）。
        results[item.fileName] = { text: '', source: 'oidb' };
        continue;
      }
      results[item.fileName] = {
        text,
        source: 'oidb',
        ...(value.width ? { width: value.width } : {}),
        ...(value.height ? { height: value.height } : {}),
        ...(value.elapsedMs !== undefined ? { elapsedMs: value.elapsedMs } : {}),
        ...(value.blocks ? { blocks: value.blocks } : {}),
      };
      onlineCount += 1;
    }
    for (const { item, error } of batch.failures) {
      quiet.log(`在线识别失败 ${item.fileName}：${error}`, 'warn');
    }
    onLog?.(
      `在线识别完成：成功 ${onlineCount} / 失败 ${batch.failures.length}` +
        (batch.abandoned.length > 0 ? ` · 放弃 ${batch.abandoned.length}` : ''),
    );
  } else if (onlineQueue.length > 0 && !deps.local) {
    onLog?.('未开启在线识别，也没有本地模型，这些图片无法识别', 'warn');
  }

  // ---- 3. 本地兜底：在线没拿到（含被放弃）的、且本机有本体的图 ----
  const failures: MediaFailure[] = [];
  const accounted = new Set<string>();
  const localPending = ocrQueue.filter((ref) => !(ref.fileName in results));
  const localRunnable = localPending.filter((ref) => ref.path);
  const localFn = deps.local;
  deps.onProgress?.(hasResultCount(results, ocrQueue), ocrQueue.length);

  if (localFn && localRunnable.length > 0) {
    onLog?.(`本地模型识别：${localRunnable.length} 张（并发 ${deps.localConcurrency ?? 2}）`);
    await mapLimit(localRunnable, deps.localConcurrency ?? 2, async (ref) => {
      try {
        const r = await localFn(ref.path!);
        if (r.ok) {
          const text = textOf(r);
          results[ref.fileName] = {
            text,
            source: 'local',
            ...(r.width ? { width: r.width } : {}),
            ...(r.height ? { height: r.height } : {}),
            ...(r.elapsedMs !== undefined ? { elapsedMs: r.elapsedMs } : {}),
            ...(r.blocks ? { blocks: r.blocks } : {}),
          };
          quiet.log(
            `已识别 ${ref.fileName}（本地·${text.length} 字）` +
              (r.elapsedMs !== undefined ? `，${Math.round(r.elapsedMs)}ms` : ''),
          );
        } else {
          pushFailure(failures, ref.fileName, r.error ?? '本地识别失败');
          accounted.add(ref.fileName);
          quiet.log(`本地识别失败 ${ref.fileName}：${r.error ?? '未知错误'}`, 'warn');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        pushFailure(failures, ref.fileName, message);
        accounted.add(ref.fileName);
        quiet.log(`本地识别异常 ${ref.fileName}：${message}`, 'warn');
      } finally {
        deps.onProgress?.(hasResultCount(results, ocrQueue), ocrQueue.length);
      }
    });
  }

  // 两条腿都没能给结果的：如实记失败（并说清是哪一条腿缺席）。
  const noLocalModel = localPending.filter((ref) => ref.path && !localFn).length;
  const noLocalFile = localPending.filter((ref) => !ref.path).length;
  for (const ref of localPending) {
    if (ref.fileName in results || accounted.has(ref.fileName)) continue;
    pushFailure(
      failures,
      ref.fileName,
      ref.path ? '没有可用的本地识别模型（在线识别也没成功）' : '在线识别没成功，本地也没有这张图',
    );
  }
  if (noLocalModel > 0) {
    onLog?.(`${noLocalModel} 张图在线识别没成功，又没有本地识别模型，只能记为失败`, 'warn');
  }
  if (noLocalFile > 0) {
    onLog?.(
      `${noLocalFile} 张图本机没有本体，本地模型识别不了（需要更近期的图或保持 QQ 在线）`,
      'warn',
    );
  }

  // 统计口径：「出文字」= 结果非空；两条腿各自只数出文字的（在线认过但一个字都没识别
  // 出来的图既不算成功也不算失败）。
  const produced = Object.values(results);
  const okCount = produced.filter((r) => r.text !== '').length;
  const localCount = produced.filter((r) => r.source === 'local' && r.text !== '').length;
  const summary = writeArtifact(bundleDir, results, {
    total: ocrQueue.length,
    ok: okCount,
    failed: failures.length,
    online: onlineCount,
    local: localCount,
    onlineOnly: onlineOnlyRefs.length,
    filter,
    failures,
  });
  onLog?.(
    `图片文字识别完成：${summary.stage.ok}/${summary.stage.total} 张出文字` +
      `（在线 ${summary.online} · 本地 ${summary.local}）` +
      (summary.stage.failed ? ` · 失败 ${summary.stage.failed}` : ''),
  );
  if (quiet.hidden > 0) onLog?.(`（另有 ${quiet.hidden} 条同类日志被省略）`, 'warn');
  return summary;
}

/** 已经出结果的张数（进度用）。 */
function hasResultCount(results: Record<string, OcrResultEntry>, queue: MediaRef[]): number {
  let n = 0;
  for (const ref of queue) if (ref.fileName in results) n += 1;
  return n;
}

/** 把结果写成 `ocr.json`（即使一张都没有也写，产物形状稳定）。 */
function writeArtifact(
  bundleDir: string,
  results: Record<string, OcrResultEntry>,
  stats: {
    total: number;
    ok: number;
    failed: number;
    online: number;
    local: number;
    onlineOnly: number;
    filter: OcrExportSummary['filter'];
    failures?: MediaFailure[];
  },
): OcrExportSummary {
  const filePath = join(bundleDir, OCR_RESULTS_FILE);
  const payload = {
    generatedAt: new Date().toISOString(),
    stats: {
      total: stats.total,
      ok: stats.ok,
      failed: stats.failed,
      online: stats.online,
      local: stats.local,
      onlineOnly: stats.onlineOnly,
      filtered: stats.filter ? stats.filter.skipped : 0,
    },
    /** `fileName → 识别结果`（含逐行文字与像素坐标框）。 */
    images: results,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return {
    filePath,
    total: stats.total,
    ok: stats.ok,
    failed: stats.failed,
    online: stats.online,
    local: stats.local,
    onlineOnly: stats.onlineOnly,
    filter: stats.filter,
    stage: {
      total: stats.total,
      ok: stats.ok,
      failed: stats.failed,
      ...(stats.failures && stats.failures.length > 0 ? { failures: stats.failures } : {}),
    },
    results,
  };
}
