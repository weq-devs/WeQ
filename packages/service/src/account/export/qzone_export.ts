/**
 * 好友 QQ 空间（说说）导出器。
 *
 * 与消息导出流水线不同 —— 数据来自 QQ 空间 Web CGI（`emotion_cgi_msglist_v6`），
 * 而非本地消息库。拉取能力由 deps 注入（service 包不依赖账号服务，照 chatlab
 * deps 的模式），底层 {@link import('../web/qzone').getQzoneMsgList} 需要在线 QQ
 * 的 skey/pskey，离线会抛错 —— 调用方（路由 + 前端 preflight）已先拦截离线。
 *
 * 翻页要点：服务端分页会**重复**返回条目（真机 test 实测），故按 `tid` 去重；
 * 说说按发表时间**倒序**，配合时间范围可提前停止翻页。
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { downloadUrlToFile } from '../media_url';
import type { QzoneEmotion, QzoneMsgListResult } from '../web/qzone';
import type { ExportTimeRange } from './types';

/** 注入的说说拉取能力（一页）。 */
export interface QzoneExportDeps {
  fetchMsgList: (targetUin: string, pos: number, num: number) => Promise<QzoneMsgListResult>;
}

export interface QzoneExportOpts {
  /** 目标好友 uin。 */
  targetUin: string;
  /** 展示名（写进文件头 / 进度）。 */
  name: string;
  format: 'json' | 'txt';
  /** 说说文件输出路径。 */
  outputPath: string;
  /** 传入则下载配图到该 `media/` 目录（否则不下载）。 */
  mediaRoot?: string;
  /** 发表时间窗（unix 秒），null 端开放。 */
  range?: ExportTimeRange;
  /** 拉取进度：已获取去重条数 / 总数 / 说明。 */
  onProgress: (current: number, total: number, note: string) => void;
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
}

const PAGE_SIZE = 20;
/** 翻页安全上限，防跑飞（每页 20 → 覆盖 2000 条说说）。 */
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一条说说是否落在时间窗内。 */
function inRange(e: QzoneEmotion, range?: ExportTimeRange): boolean {
  if (!range) return true;
  if (range.start != null && e.time < range.start) return false;
  if (range.end != null && e.time > range.end) return false;
  return true;
}

/**
 * 翻页拉全某好友的说说（去重）。`pos` 按实际返回条数推进；说说按时间倒序，
 * 有 `range.start` 时一旦本页最旧条目早于窗口起点即提前停止。
 */
async function fetchAllEmotions(
  deps: QzoneExportDeps,
  targetUin: string,
  range: ExportTimeRange | undefined,
  onProgress: (current: number, total: number, note: string) => void,
  signal?: AbortSignal,
): Promise<QzoneEmotion[]> {
  const seen = new Set<string>();
  const all: QzoneEmotion[] = [];
  let total = 0;
  let pos = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) break;
    let res: QzoneMsgListResult;
    try {
      res = await deps.fetchMsgList(targetUin, pos, PAGE_SIZE);
    } catch (e) {
      // pos 翻过头时服务端回结构异常 —— 对翻页而言等价「没有更多了」，优雅停止。
      if (page === 0) throw e; // 首页就失败 → 真错误（离线 / 无权限），上抛
      break;
    }
    total = res.total || total;
    if (res.list.length === 0) break;

    let fresh = 0;
    for (const e of res.list) {
      if (e.tid && !seen.has(e.tid)) {
        seen.add(e.tid);
        all.push(e);
        fresh += 1;
      }
    }
    pos += res.list.length;
    onProgress(all.length, total || all.length, `已获取 ${all.length}${total ? `/${total}` : ''} 条`);

    if (fresh === 0) break; // 整页都是旧条目 → 到底了
    if (total && all.length >= total) break;
    // 倒序早停：本页最旧一条已早于窗口起点，更早的都不要了。
    if (range?.start != null && res.list.every((e) => e.time < range.start!)) break;
    await sleep(PAGE_DELAY_MS);
  }
  return all;
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
function fmtTime(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一条说说渲染成 TXT 段落。 */
function emotionToTxt(e: QzoneEmotion): string {
  const head = `[${fmtTime(e.time)}]${e.isPrivate ? ' (私密)' : ''}${e.commentNum ? ` (评论 ${e.commentNum})` : ''}`;
  const lines = [head];
  if (e.content) lines.push(e.content);
  if (e.images.length) lines.push(`图片: ${e.images.join(', ')}`);
  lines.push('—'.repeat(24));
  return `${lines.join('\n')}\n`;
}

/** 从 URL 猜图片扩展名，缺失回退 `.jpg`。 */
function picExt(url: string): string {
  const ext = extname(url.split('?')[0] ?? '').toLowerCase();
  return /^\.(jpg|jpeg|png|gif|webp|bmp)$/.test(ext) ? ext : '.jpg';
}

/** 下载全部说说配图到 `mediaRoot`，并发 4，返回成败计数。 */
async function downloadImages(
  emotions: QzoneEmotion[],
  mediaRoot: string,
  onMedia?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number }> {
  const jobs: Array<{ url: string; dest: string }> = [];
  for (const e of emotions) {
    e.images.forEach((url, i) => {
      jobs.push({ url, dest: join(mediaRoot, `${e.tid}_${i}${picExt(url)}`) });
    });
  }
  const total = jobs.length;
  if (total === 0) { onMedia?.(0, 0); return { ok: 0, failed: 0 }; }
  await mkdir(mediaRoot, { recursive: true });

  let done = 0;
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = next++;
      if (idx >= total) return;
      const job = jobs[idx]!;
      const outcome = await downloadUrlToFile(job.url, job.dest);
      if (outcome.ok) ok += 1; else failed += 1;
      done += 1;
      onMedia?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  return { ok, failed };
}

/**
 * 导出一个好友的 QQ 空间说说到 json / txt，可选下载配图（bundle）。
 */
export async function exportQzone(
  opts: QzoneExportOpts,
  deps: QzoneExportDeps,
): Promise<QzoneExportResult> {
  opts.onProgress(0, 0, '拉取说说…');
  const fetched = await fetchAllEmotions(deps, opts.targetUin, opts.range, opts.onProgress, opts.signal);
  const filtered = fetched.filter((e) => inRange(e, opts.range));

  // 写盘（说说量级不大，一次性写；json 带缩进便于阅读）。
  const body =
    opts.format === 'json'
      ? JSON.stringify(filtered, null, 2)
      : filtered.map(emotionToTxt).join('\n');
  const stream = createWriteStream(opts.outputPath, { encoding: 'utf-8' });
  if (!stream.write(body)) await once(stream, 'drain');
  stream.end();
  await once(stream, 'finish');

  let mediaOk = 0;
  let mediaFailed = 0;
  if (opts.mediaRoot && !opts.signal?.aborted) {
    const r = await downloadImages(filtered, opts.mediaRoot, opts.onMedia, opts.signal);
    mediaOk = r.ok;
    mediaFailed = r.failed;
  }

  return { filePath: opts.outputPath, count: filtered.length, mediaOk, mediaFailed };
}
