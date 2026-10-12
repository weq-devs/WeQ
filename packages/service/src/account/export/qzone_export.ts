/**
 * QQ 空间（说说）导出器 —— 目标可以是好友或自己的空间。
 *
 * 与消息导出流水线不同 —— 数据来自 QQ 空间 Web CGI（`emotion_cgi_msglist_v6`），
 * 而非本地消息库。拉取能力由 deps 注入（service 包不依赖账号服务，照 chatlab
 * deps 的模式），底层 {@link import('../web/qzone').getQzoneMsgList} 需要在线 QQ
 * 的 skey/pskey，离线会抛错 —— 调用方（路由 + 前端 preflight）已先拦截离线。
 *
 * 翻页要点：服务端分页会**重复**返回条目（真机 test 实测），故按 `tid` 去重；
 * 说说按发表时间**倒序**，配合时间范围可提前停止翻页。
 *
 * 产物格式：json / txt / html。HTML 完整渲染：资料头（空间头像 / 昵称）+
 * 说说卡片（表情外链 qzonestyle、配图网格 + 视频卡片、赞 / 评论数、评论区含回复）；
 * 评论默认展开前 3 条、点赞默认展开前 10 人，更多可点按钮展开 / 收起（参考
 * QzoneArchive 归档页，内联脚本切换，无需联网）。配图 / 视频与互动拉取由调用方保证
 * —— 含 html 时强制下载媒体 + 拉取评论 / 点赞。
 *
 * 同一次任务的 json / txt / html 共用**一次**拉取（{@link collectQzone}）后各写一份
 * （{@link writeQzone}）：说说翻页、评论 / 点赞、配图下载都只做一遍。
 */

import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadUrlToFile } from '../media_url';
import { writeFileStream } from './table_writer';
import type { QzoneEmotion, QzoneEmotionVideo, QzoneMsgListResult } from '../web/qzone';
import type {
  QzoneComment,
  QzoneInteraction,
  QzoneInteractionTarget,
  QzoneLike,
  QzoneLikesResult,
} from '../web/qzone_interaction';
import type { ExportTimeRange } from './types';

/** 注入的说说拉取能力（一页）。 */
export interface QzoneExportDeps {
  fetchMsgList: (
    targetUin: string,
    pos: number,
    num: number,
    signal?: AbortSignal,
    captureRaw?: (text: string) => Promise<void>,
  ) => Promise<QzoneMsgListResult>;
  /**
   * Best-effort 批量读取若干说说的评论 + 点赞（空间动态页 HTML 解析，需在线 QQ）。
   * 可选 —— 未注入时「补全互动」直接跳过。返回 Map<tid, 互动>，缺漏 tid 返回空桶。
   */
  fetchInteractions?: (
    targetUin: string,
    targets: QzoneInteractionTarget[],
    signal?: AbortSignal,
    captureRaw?: (text: string) => Promise<void>,
  ) => Promise<Map<string, QzoneInteraction>>;
  /**
   * Best-effort 读单条说说的点赞名单（r.qzone qz_opcnt2）。可选 —— 注入后，
   * 「补全互动」会对动态页 HTML 没拿到赞的帖子自动补一轮权威名单（见
   * {@link attachInteractions}）；失败时保留 HTML 结果，不抛错。
   */
  fetchLikes?: (targetUin: string, tid: string, signal?: AbortSignal) => Promise<QzoneLike[]>;
  fetchLikesResult?: (
    targetUin: string,
    tid: string,
    signal?: AbortSignal,
    captureRaw?: (text: string) => Promise<void>,
  ) => Promise<QzoneLikesResult>;
}

/** 说说导出可选产物格式。 */
export type QzoneFormat = 'json' | 'txt' | 'html';

export interface QzoneExportOpts {
  /** 目标空间 uin（好友或自己）。 */
  targetUin: string;
  /** 展示名（写进文件头 / 进度）。 */
  name: string;
  format: QzoneFormat;
  /** 说说文件输出路径。 */
  outputPath: string;
  /** 传入则下载配图到该 `media/` 目录（否则不下载）。 */
  mediaRoot?: string;
  /** 发表时间窗（unix 秒），null 端开放。 */
  range?: ExportTimeRange;
  /** 拉取进度：已获取去重条数 / 总数 / 说明。 */
  onProgress: (current: number, total: number, note: string) => void;
  /** 补全互动（评论 + 点赞）：拉取说说后按 tid 逐条补。缺 deps.fetchInteractions 时忽略。 */
  includeInteraction?: boolean;
  /** 互动拉取进度。 */
  onInteraction?: (done: number, total: number, note: string) => void;
  /** 配图下载进度。 */
  onMedia?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface QzoneExportResult {
  filePath: string;
  /** 过滤后写入的说说条数。 */
  count: number;
  mediaOk: number;
  mediaFailed: number;
  mediaFiles?: string[];
  mediaOutcomes?: QzoneMediaOutcome[];
  /** 补全互动开启时的统计（未开启为 undefined）。 */
  interaction?: QzoneInteractionSummary;
}

/** 补全互动（评论 + 点赞）的统计。 */
export interface QzoneInteractionSummary {
  /** 带互动的说说条数（有评论或有点赞）。 */
  posts: number;
  /** 拉到的一级+二级评论总数。 */
  comments: number;
  /** 拉到的点赞用户总数。 */
  likes: number;
  /** 批量拉取整体失败（互动缺失，正文照常导出）。 */
  failed: boolean;
  missingPosts?: number;
  likesFailed?: number;
  coverage?: {
    comments: QzoneCoverageCounts;
    replies: QzoneCoverageCounts;
    likes: QzoneCoverageCounts;
  };
}

export type QzoneCoverageState = 'complete' | 'observed' | 'unobserved' | 'failed' | 'unavailable';

export type QzoneCoverageCounts = Record<QzoneCoverageState, number>;

export interface QzoneInteractionCoverage {
  comments: QzoneCoverageState;
  replies: QzoneCoverageState;
  likes: QzoneCoverageState;
}

/** 一次拉取的说说数据（含互动 / 配图统计）—— 多格式产物共用，避免重复翻页 / 重复拉互动。 */
export interface QzoneExportData {
  /** 时间窗过滤后的说说；拉过互动则 `comments` / `likes` 已挂上（否则缺失）。 */
  rows: EmotionWithInteraction[];
  /** 拉过互动时的统计（未开启为 undefined）。 */
  interaction?: QzoneInteractionSummary;
  mediaOk: number;
  mediaFailed: number;
  mediaFiles?: string[];
  mediaOutcomes?: QzoneMediaOutcome[];
  history?: {
    items: number;
    revisions: number;
    rawPages: number;
    nextPos: number;
    termination: QzonePageCapture['termination'] | null;
  };
}

/** {@link collectQzone} 的入参：拉说说 + 可选互动 / 配图。 */
export interface QzoneCollectOpts extends QzonePaginationOptions {
  onRawInteraction?: (capture: {
    kind: 'feeds' | 'likes';
    tid?: string;
    response: string;
  }) => Promise<void>;
  /** 目标空间 uin（好友或自己）。 */
  targetUin: string;
  /** 发表时间窗（unix 秒），null 端开放。 */
  range?: ExportTimeRange;
  /** 传入则下载配图 / 视频到该 `media/` 目录（否则不下载）。 */
  mediaRoot?: string;
  /** 补全互动（评论 + 点赞）：拉取说说后按 tid 逐条补。缺 deps.fetchInteractions 时忽略。 */
  includeInteraction?: boolean;
  /** 拉取进度：已获取去重条数 / 总数 / 说明。 */
  onProgress: (current: number, total: number, note: string) => void;
  /** 互动拉取进度。 */
  onInteraction?: (done: number, total: number, note: string) => void;
  /** 配图下载进度。 */
  onMedia?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** {@link writeQzone} 的入参。 */
export interface QzoneWriteOpts {
  /** 展示名（HTML 资料头 / 标题用）。 */
  name: string;
  /** 目标空间 uin（HTML 资料头用）。 */
  targetUin: string;
  /** 产物输出路径。 */
  outputPath: string;
  /** 配图是否已落到 `media/`：true → HTML 引用本地相对路径，false → 引用远端 URL。 */
  localMedia: boolean;
}

const PAGE_SIZE = 20;
/** 翻页安全上限，防跑飞（每页 20 → 覆盖 2000 条说说）。 */
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 600;
const PAGE_OVERLAP = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface QzonePageCapture {
  targetUin: string;
  pos: number;
  nextPos: number;
  total: number;
  rows: QzoneEmotion[];
  rawResponses?: string[];
  requestPositions?: number[];
  anchors?: Array<{ tid: string; time: number }>;
  /** True when revisiting position zero within an existing capture. */
  continuation?: boolean;
  termination: 'more' | 'empty-page' | 'stable-tail' | 'time-range' | 'repeated-page';
}

export interface QzonePaginationOptions {
  startPos?: number;
  /** Rows saved before a resumed cursor; returned again so the final export stays complete. */
  initialRows?: QzoneEmotion[];
  /** Tail IDs from the last saved page. The first resumed page must overlap them. */
  expectedAnchorTids?: string[];
  expectedAnchors?: Array<{ tid: string; time: number }>;
  /** Re-find the last saved overlap using bounded existing CGI reads. */
  relocateCursor?: boolean;
  /** Save rows and the next cursor together; failure leaves this page retryable. */
  onPage?: (page: QzonePageCapture) => Promise<void>;
}

export class QzonePaginationError extends Error {
  constructor(
    message: string,
    readonly partialRows: QzoneEmotion[],
    readonly nextPos: number,
    readonly reason:
      | 'request-failed'
      | 'cancelled'
      | 'repeated-page'
      | 'page-limit'
      | 'invalid-page'
      | 'cursor-drift'
      | 'persist-failed',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'QzonePaginationError';
  }
}

/** 一条说说是否落在时间窗内。 */
function inRange(e: QzoneEmotion, range?: ExportTimeRange): boolean {
  if (!range) return true;
  if (range.start != null && e.time < range.start) return false;
  if (range.end != null && e.time > range.end) return false;
  return true;
}

/**
 * 翻页拉全某个空间的说说（去重）。`pos` 按实际返回条数推进；说说按时间倒序，
 * 有 `range.start` 时一旦本页最旧条目早于窗口起点即提前停止。
 *
 * 也供年度报告「QQ 空间回忆」页复用 —— 好友空间导出与报告共用同一条已抓包验证
 * 的翻页通路（页大小 / 翻页间隔 / 去重 / 早停），避免两处各养一套分页参数。
 */
export async function fetchQzoneEmotionRange(
  deps: Pick<QzoneExportDeps, 'fetchMsgList'>,
  targetUin: string,
  range: ExportTimeRange | undefined,
  onProgress: (current: number, total: number, note: string) => void,
  signal?: AbortSignal,
  pagination: QzonePaginationOptions = {},
): Promise<QzoneEmotion[]> {
  const all: QzoneEmotion[] = [...(pagination.initialRows ?? [])];
  const seen = new Set(all.map((row) => row.tid));
  let total = 0;
  let pos = pagination.startPos ?? 0;
  let anchors = pagination.expectedAnchors ?? [];
  let expectedAnchor: Set<string> | null = anchors.length
    ? new Set(anchors.map((anchor) => anchor.tid))
    : pagination.expectedAnchorTids?.length
      ? new Set(pagination.expectedAnchorTids)
      : null;
  let continuation = Boolean(pagination.initialRows?.length) || pos > 0;
  let relocationReads = 0;
  if (!Number.isSafeInteger(pos) || pos < 0) throw new Error('空间分页位置无效。');

  const capturePage = async (capture: QzonePageCapture): Promise<void> => {
    if (signal?.aborted)
      throw new QzonePaginationError('空间导出已取消，尚未完成。', all, pos, 'cancelled');
    try {
      await pagination.onPage?.(capture);
    } catch (cause) {
      throw new QzonePaginationError(
        '空间分页保存失败，游标未推进。',
        all,
        pos,
        'persist-failed',
        cause,
      );
    }
  };

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted)
      throw new QzonePaginationError('空间导出已取消，尚未完成。', all, pos, 'cancelled');
    let res: QzoneMsgListResult;
    let pagePos = pos;
    const rawResponses: string[] = [];
    const requestPositions: number[] = [];
    const readPositions = new Set<number>();
    const observedRows: QzoneEmotion[] = [];
    const read = async (position: number): Promise<QzoneMsgListResult> => {
      if (signal?.aborted)
        throw new QzonePaginationError('空间导出已取消，尚未完成。', all, pos, 'cancelled');
      try {
        readPositions.add(position);
        const result = await deps.fetchMsgList(
          targetUin,
          position,
          PAGE_SIZE,
          signal,
          async (text) => {
            rawResponses.push(text);
            requestPositions.push(position);
          },
        );
        if (signal?.aborted)
          throw new QzonePaginationError('空间导出已取消，尚未完成。', all, pos, 'cancelled');
        if (result.list.some((row) => !row.tid))
          throw new QzonePaginationError('空间响应缺少条目 ID。', all, pos, 'invalid-page');
        observedRows.push(...result.list);
        return result;
      } catch (error) {
        if (error instanceof QzonePaginationError) throw error;
        throw new QzonePaginationError(
          signal?.aborted
            ? '空间导出已取消，尚未完成。'
            : '空间分页请求失败，已取得的内容可继续保存。',
          all,
          pos,
          signal?.aborted ? 'cancelled' : 'request-failed',
          error,
        );
      }
    };
    res = await read(pagePos);
    const overlaps = (list: QzoneEmotion[]): boolean =>
      !expectedAnchor || list.some((row) => expectedAnchor?.has(row.tid));
    if (!overlaps(res.list) && pagination.relocateCursor) {
      const anchorTimes = anchors.map((anchor) => anchor.time).filter(Number.isFinite);
      const oldestAnchor = anchorTimes.length ? Math.min(...anchorTimes) : null;
      const newerPage =
        oldestAnchor !== null &&
        res.list.length > 0 &&
        res.list.every((row) => row.time > oldestAnchor);
      const tried = new Set([pos]);
      // Insertions usually move the overlap forward; deletions move it back.
      // Search both directions because pinned posts need not be time-ordered.
      for (
        let distance = 1;
        distance <= 4 && relocationReads < 8 && !overlaps(res.list);
        distance++
      ) {
        const delta = distance * (PAGE_SIZE - PAGE_OVERLAP);
        const positions = newerPage
          ? [pos + delta, Math.max(0, pos - delta)]
          : [Math.max(0, pos - delta), pos + delta];
        for (const candidate of positions) {
          if (tried.has(candidate) || relocationReads >= 8) continue;
          relocationReads++;
          tried.add(candidate);
          await sleep(PAGE_DELAY_MS);
          const probe = await read(candidate);
          if (overlaps(probe.list)) {
            res = probe;
            pagePos = candidate;
            break;
          }
        }
      }
    }
    if (!overlaps(res.list))
      throw new QzonePaginationError(
        '空间列表位置已变化，未找到保存的重叠锚点；已保留断点。',
        all,
        pos,
        'cursor-drift',
      );
    // A shifted page can expose newly added head rows. Revisit the head once
    // after relocation so those already-visible additions are not discarded.
    if (
      (pagePos !== pos || (pagination.relocateCursor && page > 0 && res.list.length < PAGE_SIZE)) &&
      relocationReads < 8 &&
      !readPositions.has(0)
    ) {
      relocationReads++;
      await sleep(PAGE_DELAY_MS);
      await read(0);
    }
    const pageAnchors = res.list
      .slice(-PAGE_OVERLAP)
      .map((row) => ({ tid: row.tid, time: row.time }));
    total = res.total || total;
    if (res.list.length === 0) {
      await capturePage({
        targetUin,
        pos: pagePos,
        nextPos: pagePos,
        total,
        rows: [],
        rawResponses,
        requestPositions,
        anchors: pageAnchors,
        continuation,
        termination: 'empty-page',
      });
      return all;
    }

    let fresh = 0;
    const freshRows: QzoneEmotion[] = [];
    for (const e of observedRows) {
      if (e.tid && !seen.has(e.tid)) {
        seen.add(e.tid);
        fresh += 1;
        freshRows.push(e);
      }
    }
    const shortPage = res.list.length < PAGE_SIZE;
    if (fresh === 0 && !shortPage) {
      await capturePage({
        targetUin,
        pos: pagePos,
        nextPos: pagePos,
        total,
        rows: observedRows,
        rawResponses,
        requestPositions,
        anchors: pageAnchors,
        continuation,
        termination: 'repeated-page',
      });
      throw new QzonePaginationError(
        '空间分页重复返回同一批内容，尚未完成。',
        all,
        pos,
        'repeated-page',
      );
    }
    const nextPos = shortPage
      ? pagePos + res.list.length
      : Math.max(pagePos + 1, pagePos + res.list.length - PAGE_OVERLAP);
    const termination =
      range?.start != null && res.list.every((e) => e.time < range.start!)
        ? 'time-range'
        : shortPage
          ? 'stable-tail'
          : 'more';
    // The sink sees every returned version, including overlapping IDs.
    await capturePage({
      targetUin,
      pos: pagePos,
      nextPos,
      total,
      rows: observedRows,
      rawResponses,
      requestPositions,
      anchors: pageAnchors,
      continuation,
      termination,
    });
    // Apply current overlapping versions only after the page is durable.
    all.push(...freshRows);
    for (const row of observedRows) {
      const index = all.findIndex((saved) => saved.tid === row.tid);
      if (index >= 0) all[index] = row;
    }
    continuation = true;
    pos = nextPos;
    anchors = res.list.slice(-PAGE_OVERLAP).map((row) => ({ tid: row.tid, time: row.time }));
    expectedAnchor = new Set(res.list.slice(-PAGE_OVERLAP).map((row) => row.tid));
    onProgress(
      all.length,
      total || all.length,
      `已获取 ${all.length}${total ? `/${total}` : ''} 条`,
    );

    if (termination !== 'more') return [...all].sort((a, b) => b.time - a.time);
    await sleep(PAGE_DELAY_MS);
  }
  throw new QzonePaginationError('空间分页达到安全上限，尚未完成。', all, pos, 'page-limit');
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
function fmtTime(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 带互动字段的说说（导出形态；未拉互动时两个字段缺失，等同 QzoneEmotion）。 */
export interface EmotionWithInteraction extends QzoneEmotion {
  comments?: QzoneComment[];
  likes?: QzoneLike[];
  interactionCoverage?: QzoneInteractionCoverage;
  likeCoverageEvidence?: { reportedTotal: number | null; receivedUnique: number; reason: string };
}

function coverageFor(state: QzoneCoverageState): QzoneInteractionCoverage {
  return { comments: state, replies: state, likes: state };
}

function summarizeInteractionCoverage(rows: EmotionWithInteraction[]): {
  comments: QzoneCoverageCounts;
  replies: QzoneCoverageCounts;
  likes: QzoneCoverageCounts;
} {
  const empty = (): QzoneCoverageCounts => ({
    complete: 0,
    observed: 0,
    unobserved: 0,
    failed: 0,
    unavailable: 0,
  });
  const result = { comments: empty(), replies: empty(), likes: empty() };
  for (const row of rows) {
    const coverage = row.interactionCoverage ?? coverageFor('unavailable');
    result.comments[coverage.comments] += 1;
    result.replies[coverage.replies] += 1;
    result.likes[coverage.likes] += 1;
  }
  return result;
}

/** HTML 转义（文本与属性值通用，防注入）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 转义 + 换行转 `<br>`（说说 / 评论正文用）。 */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

const QZONE_HTML_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef2f7; color: #243247; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: 14px; line-height: 1.7; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 14px 44px; }
  .profile { display: flex; align-items: center; gap: 14px; background: #fff; border: 1px solid #e5eaf2; border-radius: 16px; padding: 16px 18px; margin-bottom: 14px; box-shadow: 0 8px 24px rgb(32 56 88 / 0.05); }
  .profile h1 { margin: 0 0 2px; font-size: 20px; line-height: 1.4; }
  .profile p { margin: 0; color: #758298; font-size: 13px; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover; background: #e4ebf5; color: #5b6b83; font-weight: 600; font-size: 15px; }
  .profile .avatar { width: 72px; height: 72px; font-size: 26px; }
  .post-list { display: flex; flex-direction: column; gap: 14px; }
  article.card { background: #fff; border: 1px solid #e5eaf2; border-radius: 16px; padding: 16px 18px; box-shadow: 0 8px 24px rgb(32 56 88 / 0.04); }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .who { min-width: 0; }
  .who strong { display: block; font-size: 15px; line-height: 1.3; }
  .who small { display: block; color: #7e899a; font-size: 12px; line-height: 1.5; }
  .badge.is-private { display: inline-block; background: #fff3ec; color: #d46b08; border-radius: 999px; padding: 0 8px; font-size: 11px; }
  .content { margin: 10px 0 0; overflow-wrap: anywhere; }
  .em { width: 22px; height: 22px; vertical-align: -5px; margin: 0 1px; display: inline-block; }
  .mention { color: #2684ff; }
  .pictures { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 6px; margin-top: 10px; }
  .pictures.is-one { grid-template-columns: minmax(0, 1fr); }
  .pictures a { display: block; border-radius: 8px; overflow: hidden; background: #eef2f7; }
  .pictures img { display: block; width: 100%; height: 210px; object-fit: cover; }
  .pictures.is-one img { height: auto; max-height: 720px; object-fit: contain; }
  .pictures video.media-video { display: block; width: 100%; height: 210px; object-fit: contain; background: #0d1117; border-radius: 8px; }
  .pictures.is-one video.media-video { height: auto; max-height: 720px; }
  .pictures a.video-link { position: relative; }
  .video-play { position: absolute; inset: 0; display: grid; place-items: center; font-size: 22px; color: #fff; background: rgb(0 0 0 / 0.32); }
  .pictures .ph { display: block; padding: 84px 0; text-align: center; color: #8b98a8; }
  .stats { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e1e8f2; color: #7e899a; font-size: 12px; }
  .stats .likes { color: #e15b64; }
  .sep { color: #c3ccd8; }
  .toggle { border: 0; background: none; padding: 0; color: #2684ff; cursor: pointer; font-size: 12px; font-family: inherit; line-height: inherit; white-space: nowrap; }
  .toggle:hover { text-decoration: underline; }
  .comments-more { display: flex; flex-direction: column; gap: 12px; }
  [hidden] { display: none !important; }
  .comments { margin-top: 12px; display: flex; flex-direction: column; gap: 12px; background: #f5f8fc; border-radius: 12px; padding: 12px 14px; }
  .comment, .reply { display: flex; gap: 8px; }
  .comment .avatar, .reply .avatar { width: 30px; height: 30px; font-size: 13px; }
  .comment-main { min-width: 0; flex: 1; }
  .comment-meta { color: #7e899a; font-size: 12px; }
  .comment-meta b { color: #2684ff; font-weight: 600; margin-right: 4px; }
  .comment-meta time { color: #a6b0be; margin-left: 4px; }
  .comment-text { margin: 2px 0 0; overflow-wrap: anywhere; }
  .replies { margin: 10px 0 0 4px; padding-left: 12px; border-left: 2px solid #d9e5f7; display: flex; flex-direction: column; gap: 10px; }
  .cimg a { color: #2684ff; margin-right: 8px; white-space: nowrap; }
  .foot { text-align: center; color: #8b98a8; font-size: 12px; padding: 26px 0 6px; }
  @media (max-width: 600px) {
    .wrap { padding: 12px 8px 32px; }
    .card, .profile { padding: 13px 14px; border-radius: 14px; }
    .pictures { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
    .pictures img { height: 140px; }
    .pictures video.media-video { height: 140px; }
  }
`;

/**
 * 评论区 / 点赞名单展开-收起的原地切换脚本（不依赖任何外部库）：
 * 监听 `.toggle` 按钮点击，把按钮 `data-target` 选中的折叠容器 `hidden` 属性取反，
 * 并同步按钮文案（`data-more` / `data-less`）与 `aria-expanded`。点赞还有
 * `data-suffix`（尾缀「 赞了」），展开时一并显示。
 */
const QZONE_HTML_SCRIPT = `
<script>
(function () {
  'use strict';
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button.toggle') : null;
    if (!btn) return;
    var card = btn.closest('article.card');
    if (!card) return;
    var target = card.querySelector(btn.getAttribute('data-target'));
    if (!target) return;
    // 当前折叠 → 点开；当前展开 → 收起。
    var collapsed = target.hidden;
    target.hidden = !collapsed;
    var suffix = btn.getAttribute('data-suffix');
    if (suffix) {
      var suffixEl = card.querySelector(suffix);
      if (suffixEl) suffixEl.hidden = !collapsed;
    }
    btn.textContent = collapsed ? btn.getAttribute('data-less') : btn.getAttribute('data-more');
    btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
  });
})();
</script>
`;

/** QQ 空间头像（QzoneArchive 同款 qlogo2 域）；无有效 uin 返回空串。 */
function qzoneAvatarUrl(uin: string | undefined): string {
  const u = (uin ?? '').trim();
  if (!u || u === '0') return '';
  return `https://qlogo2.store.qq.com/qzone/${u}/${u}/100`;
}

/** 头像元素：有 uin 用远端 qlogo `<img>`（需联网），缺失时回退昵称首字符。 */
function avatarElement(uin: string | undefined, fallbackName: string): string {
  const url = qzoneAvatarUrl(uin);
  if (!url) {
    const fb = escapeHtml((fallbackName || '?').trim().slice(0, 1) || '?');
    return `<span class="avatar fb">${fb}</span>`;
  }
  return `<img class="avatar" src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}

/** QQ 表情渲染成 qzonestyle 外链 gif；个别新表情只有 png，首载失败自动换 png。 */
function emojiToHtml(code: string): string {
  return (
    `<img class="em" src="https://qzonestyle.gtimg.cn/qzone/em/${code}.gif" alt="[QQ表情]" ` +
    `loading="lazy" referrerpolicy="no-referrer" ` +
    `onerror="this.onerror=null;this.src='https://qzonestyle.gtimg.cn/qzone/em/${code}.png'">`
  );
}

/** 说说 / 评论正文里的提及 token（@{uin,nick}）与表情 token（[em]eXXX[/em]）。 */
const QZONE_TEXT_TOKEN_RE = /@\{uin:([^,}]+),nick:([^}]+)(?:,[^}]*)?\}|\[em\](e\d+)\[\/em\]/g;

/**
 * QQ 空间富文本 → 安全 HTML：文本转义 + 换行 `<br>`，表情渲染成外链图片，
 * 提及渲染成高亮 @昵称（与 QzoneArchive 前端/导出保持一致）。
 */
function qzoneTextToHtml(text: string): string {
  let out = '';
  let cursor = 0;
  for (const m of text.matchAll(QZONE_TEXT_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > cursor) out += escapeMultiline(text.slice(cursor, idx));
    if (m[3] !== undefined) {
      out += emojiToHtml(m[3]);
    } else {
      const uin = escapeHtml(m[1] ?? '');
      const nick = escapeHtml(m[2] ?? '');
      out += `<span class="mention" title="QQ ${uin}">@${nick}</span>`;
    }
    cursor = idx + m[0].length;
  }
  return out + escapeMultiline(text.slice(cursor));
}

/** 评论里带的图片 → 「[图片]」外链。 */
function commentPicsToHtml(c: QzoneComment): string {
  if (c.images.length === 0) return '';
  const links = c.images
    .map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">[图片]</a>`)
    .join('');
  return `<span class="cimg">${links}</span>`;
}

/** 一条评论（一级或回复）的元信息行：昵称 + 动作 + 时间。 */
function commentMetaHtml(c: QzoneComment): string {
  const who = escapeHtml(c.nickname || c.uin || 'QQ 用户');
  const parts = [`<b>${who}</b>`];
  if (c.isReply) {
    const target = (c.replyToNickname || c.replyToUin || '').trim();
    parts.push(target ? `回复 <b>${escapeHtml(target)}</b>` : '回复');
  } else {
    parts.push('评论了');
  }
  if (c.time) parts.push(`<time>${escapeHtml(fmtTime(c.time))}</time>`);
  return `<div class="comment-meta">${parts.join(' ')}</div>`;
}

/** 一级评论 + 其二级回复，flat → 分层（保持原顺序）。 */
function groupComments(
  comments: QzoneComment[],
): Array<{ root: QzoneComment; replies: QzoneComment[] }> {
  const out: Array<{ root: QzoneComment; replies: QzoneComment[] }> = [];
  const byId = new Map<string, { root: QzoneComment; replies: QzoneComment[] }>();
  for (const c of comments) {
    if (!c.isReply) {
      const bucket = { root: c, replies: [] as QzoneComment[] };
      byId.set(c.id, bucket);
      out.push(bucket);
      continue;
    }
    const parent = c.parentCommentId ? byId.get(c.parentCommentId) : undefined;
    if (parent) {
      parent.replies.push(c);
    } else {
      // 解析器一般把回复紧跟在所属一级评论之后；个别乱序时挂到最近一条保序。
      const last = out[out.length - 1];
      if (last) last.replies.push(c);
      else out.push({ root: c, replies: [] });
    }
  }
  return out;
}

/** 单条评论正文块（头像 + 元信息 + 文字）。 */
function commentContentHtml(c: QzoneComment): string {
  const avatar = avatarElement(c.uin, c.nickname);
  const text = qzoneTextToHtml(c.content);
  return (
    `<div class="${c.isReply ? 'reply' : 'comment'}">${avatar}` +
    `<div class="comment-main">${commentMetaHtml(c)}` +
    `${text || c.images.length ? `<p class="comment-text">${text}${commentPicsToHtml(c)}</p>` : ''}` +
    '</div></div>'
  );
}

/** 评论区默认展开的一级评论条数（含回复）；超出折叠，点「查看全部」展开。 */
const COMMENTS_PREVIEW = 3;
/** 点赞列表默认展开的人数；超出折叠，点「等 N 人赞了」展开。 */
const LIKES_PREVIEW = 10;

/** 单个评论块（一级评论 + 其回复）渲染成 HTML。 */
function commentBlockToHtml(block: { root: QzoneComment; replies: QzoneComment[] }): string {
  const out: string[] = ['<div class="comment">'];
  out.push(avatarElement(block.root.uin, block.root.nickname));
  out.push('<div class="comment-main">');
  out.push(commentMetaHtml(block.root));
  const text = qzoneTextToHtml(block.root.content);
  if (text || block.root.images.length) {
    out.push(`<p class="comment-text">${text}${commentPicsToHtml(block.root)}</p>`);
  }
  if (block.replies.length > 0) {
    out.push('<div class="replies">');
    for (const r of block.replies) out.push(commentContentHtml(r));
    out.push('</div>');
  }
  out.push('</div></div>');
  return out.join('');
}

/**
 * 一组评论（一级 + 回复）渲染成评论区 HTML：默认只展开前 {@link COMMENTS_PREVIEW}
 * 条一级评论，超出部分折叠进 `comments-more`，配「查看全部 / 收起评论」展开按钮
 * （参考 QzoneArchive 归档页）。
 */
function commentsToHtml(comments: QzoneComment[]): string {
  const blocks = groupComments(comments);
  const rendered = blocks.map(commentBlockToHtml);
  if (rendered.length <= COMMENTS_PREVIEW) return rendered.join('');
  const shown = rendered.slice(0, COMMENTS_PREVIEW).join('');
  const rest = rendered.slice(COMMENTS_PREVIEW).join('');
  const toggle =
    `<button type="button" class="toggle comments-toggle" data-target=".comments-more" ` +
    `data-more="查看已取得的 ${comments.length} 条评论" data-less="收起评论" ` +
    `aria-expanded="false">查看已取得的 ${comments.length} 条评论</button>`;
  return `${shown}<div class="comments-more" hidden>${rest}</div>${toggle}`;
}

/**
 * 点赞列表：≤ {@link LIKES_PREVIEW} 人直接列出；更多时折叠为前 10 人 +
 * 「等 N 人赞了」展开按钮，点开看完整名单（参考 QzoneArchive 归档页）。
 */
function likesToHtml(likes: QzoneLike[]): string {
  if (likes.length === 0) return '';
  const name = (l: QzoneLike): string => escapeHtml(l.nickname || l.uin || 'QQ用户');
  const names = likes.map(name);
  if (names.length <= LIKES_PREVIEW) {
    return `<span class="likes">♥ ${names.join('、')} 赞了</span>`;
  }
  const shown = names.slice(0, LIKES_PREVIEW).join('、');
  const rest = names.slice(LIKES_PREVIEW).join('、');
  const toggle =
    `<button type="button" class="toggle like-toggle" data-target=".like-more" ` +
    `data-suffix=".like-suffix" data-more="等 ${likes.length} 人赞了" data-less="收起" ` +
    `aria-expanded="false">等 ${likes.length} 人赞了</button>`;
  return (
    `<span class="likes">♥ <span class="like-names">${shown}</span>` +
    `<span class="like-more" hidden>、${rest}</span>` +
    `<span class="like-suffix" hidden> 赞了</span> ${toggle}</span>`
  );
}

/** 帖子统计行：赞 + 评论数。 */
function statsToHtml(e: EmotionWithInteraction): string {
  const parts: string[] = [];
  const likes = e.likes ?? [];
  const likesHtml = likesToHtml(likes);
  if (likesHtml) parts.push(likesHtml);
  // 拉过互动就按实际拉到评论数，否则用服务端返回的计数。
  const cmtTotal = Math.max(e.commentNum || 0, e.comments?.length ?? 0);
  if (cmtTotal > 0) parts.push(`<span class="cmt-count">💬 ${cmtTotal} 条评论</span>`);
  if (parts.length === 0) return '';
  return `<div class="stats">${parts.join('<span class="sep">·</span>')}</div>`;
}

function interactionCoverageText(e: EmotionWithInteraction): string {
  if (!e.interactionCoverage) return '';
  const label = (name: string, state: QzoneCoverageState): string =>
    state === 'complete'
      ? `${name}已核验`
      : state === 'observed'
        ? `${name}已取得，完整性未核验`
        : state === 'failed'
          ? `${name}读取失败`
          : `${name}未读取`;
  return [
    label('评论', e.interactionCoverage.comments),
    label('回复', e.interactionCoverage.replies),
    label('点赞名单', e.interactionCoverage.likes),
  ].join(' · ');
}

/** 视频卡片：下载了走本地 `media/`（poster 封面 + 本体 mp4），否则引用远端本体。 */
function videoToHtml(
  e: QzoneEmotion,
  v: QzoneEmotionVideo,
  i: number,
  localMedia: boolean,
  mediaFiles?: Set<string>,
): string {
  if (localMedia) {
    const body =
      !mediaFiles || mediaFiles.has(videoBodyFileName(e, i))
        ? `media/${encodeURI(videoBodyFileName(e, i))}`
        : v.videoUrl;
    const cover = v.coverUrl
      ? !mediaFiles || mediaFiles.has(videoCoverFileName(e, i))
        ? `media/${encodeURI(videoCoverFileName(e, i))}`
        : v.coverUrl
      : '';
    return (
      `<video class="media-video" controls preload="none"` +
      (cover ? ` poster="${escapeHtml(cover)}"` : '') +
      ` src="${escapeHtml(body)}"></video>`
    );
  }
  // 远端：封面图外链本体 mp4（有封面才有图，纯视频帖可能连封面都没有）。
  const inner = v.coverUrl
    ? `<img loading="lazy" src="${escapeHtml(v.coverUrl)}" alt="视频 ${i + 1}" referrerpolicy="no-referrer">`
    : '<span class="ph">[视频]</span>';
  return (
    `<a class="video-link" href="${escapeHtml(v.videoUrl)}" target="_blank" rel="noreferrer">` +
    `${inner}<span class="video-play">▶</span></a>`
  );
}

/** 说说配图网格：图片 + 视频混合排布；下载了走本地 `media/`，否则直接引用远端（完整渲染）。 */
function picturesToHtml(e: QzoneEmotion, localMedia: boolean, mediaFiles?: Set<string>): string {
  const imgs = e.images.map((url, i) => {
    const local =
      localMedia && (!mediaFiles || mediaFiles.has(imageFileName(e, url, i)))
        ? `media/${encodeURI(imageFileName(e, url, i))}`
        : '';
    const href = local || url;
    const ext = local ? '' : ' target="_blank" rel="noreferrer"';
    return `<a href="${escapeHtml(href)}"${ext}><img loading="lazy" src="${escapeHtml(href)}" alt="配图 ${i + 1}" referrerpolicy="no-referrer"></a>`;
  });
  const vids = e.videos.map((v, i) => videoToHtml(e, v, i, localMedia, mediaFiles));
  const items = [...imgs, ...vids];
  if (items.length === 0) return '';
  const one = items.length === 1;
  return `<div class="pictures${one ? ' is-one' : ''}">${items.join('')}</div>`;
}

/**
 * 一条说说渲染成 HTML article（参考 QzoneArchive 归档页）：头像 + 昵称头、
 * 正文（表情外链 / 提及）、配图、赞与评论数、评论区（含回复）。
 */
function emotionToHtml(
  e: EmotionWithInteraction,
  author: { name: string; uin: string },
  localMedia: boolean,
  mediaFiles?: Set<string>,
): string {
  const when = e.time ? fmtTime(e.time) : '';
  const privateBadge = e.isPrivate ? '<span class="badge is-private">私密</span>' : '';
  const head =
    '<header class="card-head">' +
    avatarElement(author.uin, author.name) +
    '<div class="who">' +
    `<strong>${escapeHtml(author.name || 'QQ 用户')}</strong>` +
    `<small>${when}${privateBadge ? ` · ${privateBadge}` : ''}</small>` +
    '</div></header>';
  const content = e.content ? `<div class="content">${qzoneTextToHtml(e.content)}</div>` : '';
  const pictures = picturesToHtml(e, localMedia, mediaFiles);
  const stats = statsToHtml(e);
  const coverageText = interactionCoverageText(e);
  const coverage = coverageText ? `<div class="stats">${escapeHtml(coverageText)}</div>` : '';
  const comments =
    e.comments && e.comments.length > 0
      ? `<section class="comments">${commentsToHtml(e.comments)}</section>`
      : '';
  return `<article class="card">${head}${content}${pictures}${stats}${coverage}${comments}</article>`;
}

/** 整页 HTML 文档：资料头（头像 / 昵称 / 统计）+ 各说说 article。 */
function buildHtmlDoc(name: string, uin: string, count: number, postsHtml: string): string {
  const title = escapeHtml(name || 'QQ 空间');
  const exportedAt = escapeHtml(fmtTime(Math.floor(Date.now() / 1000)));
  const profile =
    '<header class="profile">' +
    avatarElement(uin, name) +
    '<div class="profile-main">' +
    `<h1>${title} 的 QQ 空间</h1>` +
    `<p>${uin ? `QQ ${escapeHtml(uin)} · ` : ''}说说导出 · 共 ${count} 条 · 导出于 ${exportedAt}</p>` +
    '</div></header>';
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    `<title>${title} · QQ 空间说说</title>\n<style>${QZONE_HTML_STYLE}</style>\n</head>\n<body>\n` +
    `<div class="wrap">\n${profile}\n` +
    `<main class="post-list">\n${postsHtml}\n</main>\n` +
    `<footer class="foot">共 ${count} 条说说 · 导出于 ${exportedAt}</footer>\n</div>\n` +
    `${QZONE_HTML_SCRIPT}\n</body>\n</html>\n`
  );
}

/** 一条评论渲染成 TXT 行（缩进）。 */
function commentToTxt(c: QzoneComment, indent: string): string {
  const who = c.isReply
    ? `${c.nickname || c.uin} 回复 ${c.replyToNickname || c.replyToUin || ''}`.trim()
    : c.nickname || c.uin;
  const t = c.time ? ` ${fmtTime(c.time)}` : '';
  const line = `${indent}${who}${t}: ${c.content || (c.images.length ? '[图片]' : '')}`;
  return c.images.length ? `${line} 图: ${c.images.join(', ')}` : line;
}

/** 一条说说渲染成 TXT 段落（含互动时附评论 / 点赞）。 */
function emotionToTxt(e: EmotionWithInteraction): string {
  const head = `[${fmtTime(e.time)}]${e.isPrivate ? ' (私密)' : ''}${e.commentNum ? ` (评论 ${e.commentNum})` : ''}`;
  const lines = [head];
  const coverageText = interactionCoverageText(e);
  if (coverageText) lines.push(coverageText);
  if (e.content) lines.push(e.content);
  if (e.images.length) lines.push(`图片: ${e.images.join(', ')}`);
  for (const v of e.videos) {
    const dur = v.duration ? ` (${Math.round(v.duration / 1000)}s)` : '';
    lines.push(`视频${dur}${v.coverUrl ? ` 封面: ${v.coverUrl}` : ''}: ${v.videoUrl}`);
  }
  const comments = e.comments ?? [];
  const likes = e.likes ?? [];
  if (comments.length) {
    lines.push(`评论 ${comments.length} 条:`);
    for (const c of comments) lines.push(commentToTxt(c, '  '));
  }
  if (likes.length) {
    lines.push(`赞: ${likes.map((l) => l.nickname || l.uin).join('、')}`);
  }
  lines.push('—'.repeat(24));
  return `${lines.join('\n')}\n`;
}

/** 从 URL 猜图片扩展名，缺失回退 `.jpg`。 */
function picExt(url: string): string {
  const ext = extname(url.split('?')[0] ?? '').toLowerCase();
  return /^\.(jpg|jpeg|png|gif|webp|bmp)$/.test(ext) ? ext : '.jpg';
}

/** 说说配图的本地文件名 —— 下载落盘与 HTML 引用必须共用同一套命名。 */
function imageFileName(e: QzoneEmotion, url: string, i: number): string {
  return `${encodeURIComponent(e.tid)}_${i}${picExt(url)}`;
}

/** 视频本体落盘名（mp4）与封面落盘名（jpg）—— 下载与 HTML 引用共用。 */
function videoBodyFileName(e: QzoneEmotion, i: number): string {
  return `${encodeURIComponent(e.tid)}_v${i}.mp4`;
}

function videoCoverFileName(e: QzoneEmotion, i: number): string {
  return `${encodeURIComponent(e.tid)}_v${i}.jpg`;
}

export interface QzoneMediaOutcome {
  path: string;
  url: string;
  status: 'saved' | 'failed' | 'cancelled';
  /** A URL and successful download alone cannot establish original quality. */
  variant: 'unverified';
  bytes?: number;
  sha256?: string;
  reason?: string;
}

/** 下载全部说说配图 + 视频到 `mediaRoot`，并发 4，返回成败计数。 */
async function downloadMedia(
  emotions: QzoneEmotion[],
  mediaRoot: string,
  onMedia?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number; files: string[]; outcomes: QzoneMediaOutcome[] }> {
  const jobs: Array<{ url: string; dest: string; path: string; kind: 'image' | 'video' }> = [];
  const files: string[] = [];
  const outcomes: QzoneMediaOutcome[] = [];
  for (const e of emotions) {
    e.images.forEach((url, i) => {
      jobs.push({
        url,
        dest: join(mediaRoot, imageFileName(e, url, i)),
        path: imageFileName(e, url, i),
        kind: 'image',
      });
    });
    e.videos.forEach((v, i) => {
      if (v.videoUrl) {
        jobs.push({
          url: v.videoUrl,
          dest: join(mediaRoot, videoBodyFileName(e, i)),
          path: videoBodyFileName(e, i),
          kind: 'video',
        });
      }
      if (v.coverUrl) {
        jobs.push({
          url: v.coverUrl,
          dest: join(mediaRoot, videoCoverFileName(e, i)),
          path: videoCoverFileName(e, i),
          kind: 'image',
        });
      }
    });
  }
  const total = jobs.length;
  if (total === 0) {
    onMedia?.(0, 0);
    return { ok: 0, failed: 0, files, outcomes };
  }
  if (signal?.aborted) {
    for (const job of jobs)
      outcomes.push({ path: job.path, url: job.url, status: 'cancelled', variant: 'unverified' });
    return { ok: 0, failed: jobs.length, files, outcomes };
  }
  await mkdir(mediaRoot, { recursive: true });

  let done = 0;
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= total) return;
      const job = jobs[idx]!;
      if (signal?.aborted) {
        failed += 1;
        outcomes.push({ path: job.path, url: job.url, status: 'cancelled', variant: 'unverified' });
        continue;
      }
      const outcome = await downloadUrlToFile(job.url, job.dest, {
        signal,
        expectedKind: job.kind,
      });
      if (outcome.ok) {
        ok += 1;
        files.push(job.path);
        outcomes.push({
          path: job.path,
          url: job.url,
          status: 'saved',
          variant: 'unverified',
          bytes: outcome.bytes,
          sha256: outcome.sha256,
        });
      } else {
        failed += 1;
        outcomes.push({
          path: job.path,
          url: job.url,
          status: signal?.aborted ? 'cancelled' : 'failed',
          variant: 'unverified',
          reason: outcome.reason,
        });
      }
      done += 1;
      onMedia?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  return { ok, failed, files, outcomes };
}

/**
 * 批量补拉说说评论 + 点赞，挂在 emotion 上（含空的互动桶；便于 JSON 稳定输出）。
 * 拉取整体失败时返回 failed=true，正文照常导出 —— 互动是增强项，不能因它废掉整次导出。
 */
async function attachInteractions(
  filtered: EmotionWithInteraction[],
  deps: QzoneExportDeps,
  opts: QzoneCollectOpts,
): Promise<{
  failed: boolean;
  interactionPosts: number;
  missingPosts?: number;
  likesFailed?: number;
}> {
  const onInteraction = opts.onInteraction;
  let commentsFailed = false;
  let commentsBlocked = false;
  let missingPosts = 0;
  let likesFailed = 0;
  for (const row of filtered) {
    row.comments ??= [];
    row.likes ??= [];
    row.interactionCoverage ??= coverageFor('unobserved');
  }
  if (!deps.fetchInteractions) {
    for (const row of filtered) {
      row.interactionCoverage!.comments = 'unavailable';
      row.interactionCoverage!.replies = 'unavailable';
    }
    commentsFailed = true;
  } else {
    try {
      onInteraction?.(0, filtered.length, '拉取评论 / 点赞…');
      const targets = filtered.map((row) => ({ tid: row.tid, time: row.time }));
      const map = await deps.fetchInteractions(
        opts.targetUin,
        targets,
        opts.signal,
        opts.onRawInteraction
          ? (response) => opts.onRawInteraction!({ kind: 'feeds', response })
          : undefined,
      );
      opts.signal?.throwIfAborted();
      for (const row of filtered) {
        const result = map.get(row.tid);
        if (!result || result.coverage === 'unobserved') missingPosts++;
        if (!result) continue;
        row.comments = result.comments;
        row.likes = result.likes;
        row.interactionCoverage = result.fieldCoverage
          ? { ...result.fieldCoverage }
          : coverageFor(result.coverage === 'unobserved' ? 'unobserved' : 'observed');
      }
    } catch (error) {
      opts.signal?.throwIfAborted();
      commentsFailed = true;
      const classified = error as { kind?: string; name?: string };
      commentsBlocked = classified.kind === 'rate-limit' || classified.name === 'WebAuthError';
      for (const row of filtered) {
        row.interactionCoverage!.comments = row.comments!.length ? 'observed' : 'failed';
        row.interactionCoverage!.replies = row.comments!.some((comment) => comment.isReply)
          ? 'observed'
          : 'failed';
      }
      onInteraction?.(0, filtered.length, '评论读取未完成，保留正文并继续处理点赞');
    }
  }
  // The structured source can attest its reported count. Legacy array-only
  // providers and HTML observations cannot establish complete membership.
  const needLikes = commentsBlocked
    ? []
    : deps.fetchLikesResult
      ? filtered
      : deps.fetchLikes
        ? filtered.filter((row) => row.likes!.length === 0)
        : [];
  let next = 0;
  let done = 0;
  let stopRequests = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted || stopRequests) return;
      const row = needLikes[next++];
      if (!row) return;
      try {
        const result = deps.fetchLikesResult
          ? await deps.fetchLikesResult(
              opts.targetUin,
              row.tid,
              opts.signal,
              opts.onRawInteraction
                ? (response) => opts.onRawInteraction!({ kind: 'likes', tid: row.tid, response })
                : undefined,
            )
          : {
              likes: await deps.fetchLikes!(opts.targetUin, row.tid, opts.signal),
              reportedTotal: null,
              coverage: 'observed' as const,
              reason: 'missing-count' as const,
            };
        opts.signal?.throwIfAborted();
        const merged = new Map(row.likes!.map((like) => [like.uin, like]));
        for (const like of result.likes) merged.set(like.uin, like);
        row.likes = [...merged.values()];
        const conflicting =
          result.reportedTotal !== null && row.likes.length !== result.reportedTotal;
        row.interactionCoverage!.likes = conflicting
          ? 'observed'
          : result.coverage === 'observed' && row.likes.length === 0
            ? 'unobserved'
            : result.coverage;
        row.likeCoverageEvidence = {
          reportedTotal: result.reportedTotal,
          receivedUnique: row.likes.length,
          reason: conflicting ? 'observations-conflict' : result.reason,
        };
      } catch (error) {
        opts.signal?.throwIfAborted();
        likesFailed++;
        row.interactionCoverage!.likes = row.likes!.length ? 'observed' : 'failed';
        row.likeCoverageEvidence = {
          reportedTotal: null,
          receivedUnique: row.likes!.length,
          reason: 'request-failed',
        };
        const classified = error as { kind?: string; name?: string };
        if (classified.kind === 'rate-limit' || classified.name === 'WebAuthError')
          stopRequests = true;
      }
      done++;
      if (!stopRequests && next < needLikes.length) await sleep(PAGE_DELAY_MS);
      onInteraction?.(done, needLikes.length, `读取点赞 ${done}/${needLikes.length}…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, needLikes.length) }, worker));
  opts.signal?.throwIfAborted();
  const posts = filtered.filter((row) => row.comments!.length || row.likes!.length).length;
  onInteraction?.(filtered.length, filtered.length, `已取得 ${posts} 条说说的互动内容`);
  return {
    failed: commentsFailed || missingPosts > 0 || likesFailed > 0,
    interactionPosts: posts,
    missingPosts,
    likesFailed,
  };
}

/**
 * 拉取一个空间的说说，并按需补全互动（评论 / 点赞）+ 下载配图 / 视频，返回一份可复用
 * 的数据。同一次任务的多格式产物（json / txt / html）共用它 —— 每个格式各拉一次的话，
 * 只有第一份会带互动与本地配图，排在后面的 HTML 会退化成「无评论无赞 + 远端图」。
 */
export async function collectQzone(
  opts: QzoneCollectOpts,
  deps: QzoneExportDeps,
): Promise<QzoneExportData> {
  opts.onProgress(0, 0, '拉取说说…');
  const fetched = await fetchQzoneEmotionRange(
    deps,
    opts.targetUin,
    opts.range,
    opts.onProgress,
    opts.signal,
    opts,
  );
  // 互动字段挂在 EmotionWithInteraction 上；不带互动时数组元素仍是合法 QzoneEmotion。
  const rows: EmotionWithInteraction[] = fetched.filter((e) => inRange(e, opts.range));

  // 补全互动（评论 + 点赞）：批量拉一次，各格式产物共用。
  let interaction: QzoneInteractionSummary | undefined;
  if (opts.includeInteraction && !opts.signal?.aborted) {
    const { failed, interactionPosts, missingPosts, likesFailed } = await attachInteractions(
      rows,
      deps,
      opts,
    );
    const commentCount = rows.reduce((s, e) => s + (e.comments?.length ?? 0), 0);
    const likeCount = rows.reduce((s, e) => s + (e.likes?.length ?? 0), 0);
    interaction = {
      posts: interactionPosts,
      comments: commentCount,
      likes: likeCount,
      failed,
      missingPosts,
      likesFailed,
      coverage: summarizeInteractionCoverage(rows),
    };
  }

  let mediaOk = 0;
  let mediaFailed = 0;
  let mediaFiles: string[] | undefined;
  let mediaOutcomes: QzoneMediaOutcome[] | undefined;
  if (opts.mediaRoot) {
    const r = await downloadMedia(rows, opts.mediaRoot, opts.onMedia, opts.signal);
    mediaOk = r.ok;
    mediaFailed = r.failed;
    mediaFiles = r.files;
    mediaOutcomes = r.outcomes;
  }

  return {
    rows,
    mediaOk,
    mediaFailed,
    mediaFiles,
    mediaOutcomes,
    ...(interaction ? { interaction } : {}),
  };
}

/**
 * 把一份 {@link QzoneExportData} 按指定格式写盘（说说量级不大，一次性写；json 带缩进
 * 便于阅读）。HTML 的配图引用由 `localMedia` 决定：本地 `media/` 相对路径或远端 URL。
 */
export async function writeQzone(
  format: QzoneFormat,
  data: QzoneExportData,
  opts: QzoneWriteOpts,
): Promise<void> {
  const rows = data.rows;
  const body =
    format === 'json'
      ? JSON.stringify(rows, null, 2)
      : format === 'html'
        ? buildHtmlDoc(
            opts.name,
            opts.targetUin,
            rows.length,
            rows
              .map((e) =>
                emotionToHtml(
                  e,
                  { name: opts.name, uin: opts.targetUin },
                  opts.localMedia,
                  data.mediaFiles ? new Set(data.mediaFiles) : undefined,
                ),
              )
              .join('\n'),
          )
        : rows.map(emotionToTxt).join('\n');
  await writeFileStream(opts.outputPath, body);
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  await writeFileStream(
    `${opts.outputPath}.coverage.json`,
    JSON.stringify(
      {
        version: 1,
        rows: rows.length,
        bodySha256,
        mediaRequested: data.mediaOutcomes !== undefined,
        mediaOk: data.mediaOk,
        mediaFailed: data.mediaFailed,
        media: data.mediaOutcomes ?? [],
        originalQualityVerified: false,
        interaction: data.interaction ?? null,
        fullInteractionCoverageVerified: false,
        history: data.history ?? null,
      },
      null,
      2,
    ),
  );
}

/** 拉取 + 写盘一步到位（单格式便捷入口）。多格式导出请用 {@link collectQzone} 拉一次后多次 {@link writeQzone}。 */
export async function exportQzone(
  opts: QzoneExportOpts,
  deps: QzoneExportDeps,
): Promise<QzoneExportResult> {
  const data = await collectQzone(
    {
      targetUin: opts.targetUin,
      range: opts.range,
      mediaRoot: opts.mediaRoot,
      includeInteraction: opts.includeInteraction,
      onProgress: opts.onProgress,
      onInteraction: opts.onInteraction,
      onMedia: opts.onMedia,
      signal: opts.signal,
    },
    deps,
  );
  await writeQzone(opts.format, data, {
    name: opts.name,
    targetUin: opts.targetUin,
    outputPath: opts.outputPath,
    localMedia: Boolean(opts.mediaRoot),
  });
  return {
    filePath: opts.outputPath,
    count: data.rows.length,
    mediaOk: data.mediaOk,
    mediaFailed: data.mediaFailed,
    mediaFiles: data.mediaFiles,
    mediaOutcomes: data.mediaOutcomes,
    ...(data.interaction ? { interaction: data.interaction } : {}),
  };
}
