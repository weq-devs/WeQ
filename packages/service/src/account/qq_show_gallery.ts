/**
 * QqShowGalleryService — 「QQ 秀展柜」的历史形象扫描。
 *
 * 背景（2026-11 实测，见 docs/develop/qqshow-protocol-20261031.md）：`0xFE1_3` 只回
 * **当前**形象，但完整版形象图按 `images/<uin>/<n>.png` 命名，`n` 从 101 起单调递增，
 * 每次「保存形象」+1，旧版本长期留在 CDN 上（部分版本会因发布失败而缺号，属正常现象）。
 * 所以历史形象可以靠枚举序号 + 直取 CDN 图拿回来，不需要任何服务端接口。
 *
 * 扫描策略（与服务端「找不到 100% 成功」妥协一致）：
 *  - 从 101 起**并发**探测，命中一张就推一张给渲染层（不等整轮跑完）；
 *  - **连续 {@link EMPTY_STOP} 个序号都取不到**才判定结尾 —— 号段里偶发的缺号不会误停；
 *  - 命中后并发拉字节、算 md5，内容相同的归成一组（同一次保存多次、重复保存同一套形象
 *    都会产生内容相同的不同序号，展柜里只展示一张）；
 *  - 并发有上限，别把 CDN 打崩；用户关掉窗口就 abort。
 *
 * 图片字节全部经包内的 {@link MediaCacheService} 落盘（子目录 `qqshow`），与聊天头像
 * 用的 QQ 秀缓存同一份，前端用 `weq-media://qqshow?src=…` 渲染即可。
 */

import { createHash } from 'node:crypto';
import type { MediaCacheService } from '../bootstrap/media_cache';

/** 起始序号 —— 实测所有账号都从 101 开始。 */
export const QQSHOW_GALLERY_START = 101;
/** 连续多少个序号拿不到就判定扫完。 */
export const EMPTY_STOP = 10;
/** 同时在途的探测请求数上限。 */
const PROBE_CONCURRENCY = 6;
/** 每批发出去探测的序号个数（批内并发，批间推进）。 */
const WINDOW = EMPTY_STOP * 3;
/** 兜底上限：防止异常账号号段特别大时无限扫下去。 */
export const MAX_PROBE = 2000;

/** 一张命中的历史形象。`revision` 就是 URL 里的序号。 */
export interface QqShowGalleryItem {
  revision: number;
  /** 原图 URL（CDN 地址，经主进程缓存代理渲染）。 */
  url: string;
  /** 字节的 md5 —— 内容去重键。 */
  md5: string;
  /** 字节数（展示用）。 */
  bytes: number;
}

/** 推给渲染层的进度事件。 */
export type QqShowGalleryEvent =
  | {
      kind: 'item';
      item: QqShowGalleryItem;
      /** 去重后已找到的张数。 */
      count: number;
      /** 已经探测过的最远序号（进度条用）。 */
      scanned: number;
      /** 当前已知的最远命中序号 —— 也就是判定出来的结尾下界。 */
      ceiling: number;
    }
  | { kind: 'progress'; scanned: number; ceiling: number; found: number }
  | { kind: 'done'; found: number; scanned: number; truncated: boolean; error?: string };

export interface QqShowGalleryOptions {
  cache: Pick<MediaCacheService, 'get'>;
  /** 扫描起点（缺省 101）。 */
  start?: number;
  signal?: AbortSignal;
  /** 推事件；订阅方断开后抛错会被吞掉，扫描本身继续跑完并落盘。 */
  emit: (event: QqShowGalleryEvent) => void;
}

function imageUrl(uin: string, revision: number): string {
  return `https://images.qqshow.gtimg.com/images/${uin}/${revision}.png`;
}

/**
 * 拉一张图：命中返回条目，404 / 网络错误一律返回 `null`（当成「这个序号不存在」）。
 *
 * 用 `cache.get(url, 'qqshow', 0)`：`ttl=0` 表示不读旧缓存、总是回源 —— 探测本身
 * 就是在问「这个序号在不在」，读缓存会把先前的结论固化下来。命中后字节照样落盘，
 * 后续渲染直接走磁盘。
 */
async function probe(
  cache: Pick<MediaCacheService, 'get'>,
  uin: string,
  revision: number,
): Promise<QqShowGalleryItem | null> {
  const url = imageUrl(uin, revision);
  try {
    const blob = await cache.get(url, 'qqshow', 0);
    if (blob.data.length === 0) return null;
    return {
      revision,
      url,
      md5: createHash('md5').update(blob.data).digest('hex'),
      bytes: blob.data.length,
    };
  } catch {
    return null;
  }
}

/**
 * 扫一个账号的整段历史形象。
 *
 * 批处理推进：每批探测 `WINDOW` 个连续序号（批内并发 `PROBE_CONCURRENCY`），批内命中
 * 即时推送；批结束后核算「最远命中后的连续缺号数」，够 {@link EMPTY_STOP} 就收尾。
 */
export async function scanQqShowGallery(uin: string, options: QqShowGalleryOptions): Promise<void> {
  if (!/^\d{5,20}$/.test(uin)) throw new Error('无效的 QQ 号');
  const start = Math.max(1, options.start ?? QQSHOW_GALLERY_START);
  const { cache, signal } = options;
  const emit = (event: QqShowGalleryEvent): void => {
    try {
      options.emit(event);
    } catch {
      /* 订阅方已关闭 —— 扫描继续跑完，字节照样落盘 */
    }
  };

  const seenMd5 = new Set<string>();
  /** 已确认存在的最远序号。 */
  let maxHit = start - 1;
  /** 已探测过的最远序号。 */
  let scanned = start - 1;
  let found = 0;
  let truncated = false;
  let aborted = false;

  let next = start;
  while (next <= MAX_PROBE) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    // 批大小不是常数：每批最多推进到 `maxHit + EMPTY_STOP`（再往后就没有意义了），
    // 这样「连续 EMPTY_STOP 个空号」就是精确的收尾条件，不会多扫一整窗。
    const batch: number[] = [];
    const limit = Math.min(MAX_PROBE, maxHit + EMPTY_STOP);
    for (let i = 0; i < WINDOW && next <= limit; i++) batch.push(next++);
    if (batch.length === 0) break;
    const batchEnd = batch[batch.length - 1]!;

    await new Promise<void>((resolve) => {
      let cursor = 0;
      let live = 0;
      const finish = (): void => {
        if (live === 0 && cursor >= batch.length) resolve();
      };
      const launch = (): void => {
        while (live < PROBE_CONCURRENCY && cursor < batch.length && !aborted) {
          const revision = batch[cursor++]!;
          live++;
          void probe(cache, uin, revision).then((hit) => {
            live--;
            if (!hit) {
              launch();
              finish();
              return;
            }
            if (revision > maxHit) maxHit = revision;
            if (!seenMd5.has(hit.md5)) {
              seenMd5.add(hit.md5);
              found++;
              emit({
                kind: 'item',
                item: hit,
                count: found,
                scanned: Math.max(scanned, revision),
                ceiling: maxHit,
              });
            }
            launch();
            finish();
          });
        }
        if (cursor >= batch.length) finish();
      };
      launch();
    });

    scanned = batchEnd;
    emit({ kind: 'progress', scanned, ceiling: maxHit, found });
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    // maxHit 之后的序号（maxHit+1 … batchEnd）全部未命中 —— 连续缺号数就是这段长度。
    if (batchEnd - maxHit >= EMPTY_STOP) break;
    if (batchEnd >= MAX_PROBE) truncated = true;
  }

  emit({ kind: 'done', found, scanned, truncated: truncated || aborted });
}
