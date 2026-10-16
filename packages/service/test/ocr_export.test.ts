/**
 * 导出阶段「图片文字识别」的单测 —— 钉住三条策略：
 *
 *   1. **预筛选**：只把「检测到文字」的图送进识别模型；筛图失败按有文字处理（宁可多
 *      跑一次，也不静默丢文字）；筛图模型不可用就整体跳过筛选。
 *   2. **在线优先、从新到旧**：CDN 直链只有约 9 天寿命，越新的越可能还能取。
 *   3. **连续失败即放弃在线**：连败到上限就整体放弃，剩下的（含被放弃的）回退本地模型；
 *      没有本地模型就如实记失败，`ocr.json` 照样写（产物形状稳定）。
 *   4. **筛图与在线并行 + 进度/心跳**：筛好一张就发一张（不等整批筛完）；分母是真张数，
 *      在线每张落地都推进一次，等回包时还有心跳日志（2026-10-16 那次"卡在 0% 到结束"
 *      就是这个反面）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, MediaScanResult } from '../src/account/export/media_scan';
import {
  OCR_RESULTS_FILE,
  ocrFoundImages,
  runBatchWithFailureLimit,
} from '../src/account/export/ocr_export';
import { rewriteOcrTexts } from '../src/account/export/ocr_rewrite';
import { OcrResultCache } from '../src/common/ocr_cache';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-ocr-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 一张本机有本体的图片引用。 */
function pic(fileName: string, extra: Partial<MediaRef> = {}): MediaRef {
  return {
    msgId: '1',
    msgSeq: '1',
    sendTime: 1_700_000_000,
    kind: 'pic',
    fileName,
    stem: fileName.toLowerCase().replace(/\.[^.]+$/, ''),
    fileToken: `token-${fileName}`,
    originalUrl: '',
    uploadTime: 0,
    uploadTimestamp: 0,
    fileTTL: 0,
    expiresAt: 0,
    expired: false,
    path: join(dir, fileName),
    ocr: {
      senderUin: '10001',
      peerUin: '10002',
      isGroup: true,
      md5: '',
      width: 800,
      height: 600,
      fileSize: 1234,
    },
    ...extra,
  };
}

/** 一张本机没有本体、但还能下载的图片引用（只能走在线）。 */
function missingPic(fileName: string, sendTime: number): MediaRef {
  return { ...pic(fileName, { sendTime }), path: null };
}

function scan(found: MediaRef[], downloadList: MediaRef[] = []): MediaScanResult {
  return {
    totalRefs: found.length + downloadList.length,
    uniqueFiles: found.length + downloadList.length,
    foundFiles: found.length,
    missingFiles: downloadList.length,
    expiredFiles: 0,
    downloadableFiles: downloadList.length,
    byKind: {
      pic: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      video: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      ptt: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      emoji: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      file: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    },
    found,
    missing: downloadList,
    downloadList,
    collectMs: 0,
    indexBuildMs: 0,
    matchMs: 0,
    durationMs: 0,
    indexedDirs: 0,
    indexedFiles: 0,
  };
}

function readArtifact(): {
  stats: Record<string, number>;
  images: Record<string, { text: string; source: string; blocks?: unknown[] }>;
} {
  return JSON.parse(readFileSync(join(dir, OCR_RESULTS_FILE), 'utf-8'));
}

describe('runBatchWithFailureLimit', () => {
  it('连续失败到上限就整体放弃，剩余项进 abandoned（成功会把连败清零）', async () => {
    const items = ['bad1', 'ok1', 'bad2', 'bad3', 'bad4'];
    const seen: string[] = [];
    const r = await runBatchWithFailureLimit(
      items,
      async (item) => {
        seen.push(item);
        return item.startsWith('ok') ? { ok: true, value: item } : { ok: false, error: 'boom' };
      },
      { concurrency: 1, failureLimit: 2 },
    );
    // bad1 之后 ok1 成功把连败清零；bad2 + bad3 连败到上限 2 → 直接收手。
    expect(seen).toEqual(['bad1', 'ok1', 'bad2', 'bad3']);
    expect(r.results.map((x) => x.item)).toEqual(['ok1']);
    expect(r.failures.map((x) => x.item)).toEqual(['bad1', 'bad2', 'bad3']);
    expect(r.abandoned).toEqual(['bad4']);

    // 连败到上限（并发 1 时就是字面意义的连续）后不再尝试新的项。
    const seen2: string[] = [];
    const r2 = await runBatchWithFailureLimit(
      ['bad1', 'bad2', 'bad3', 'ok'],
      async (item) => {
        seen2.push(item);
        return item === 'ok' ? { ok: true, value: item } : { ok: false, error: 'boom' };
      },
      { concurrency: 1, failureLimit: 2 },
    );
    expect(seen2).toEqual(['bad1', 'bad2']);
    expect(r2.abandoned).toEqual(['bad3', 'ok']);
  });
});

describe('ocrFoundImages', () => {
  it('预筛选：没文字的图不进识别模型（筛选失败按有文字处理）', async () => {
    const local = vi.fn(async () => ({ ok: true, text: '文字', width: 800, height: 600 }));
    const filter = vi.fn(async (path: string) => {
      if (path.endsWith('c.jpg')) return { ok: false as const, error: '模型坏了' };
      return { ok: true as const, hasText: !path.endsWith('b.jpg'), boxes: 2 };
    });
    const s = scan([pic('a.jpg'), pic('b.jpg'), pic('c.jpg')]);
    const r = await ocrFoundImages(s, dir, { filter, local, filterConcurrency: 1 });

    expect(filter).toHaveBeenCalledTimes(3);
    // b.jpg 被判为没文字 → 不进识别；c.jpg 筛图失败 → 按有文字处理仍送识别。
    // withText 只数「检测到文字」的；筛选失败单独计数（但同样送进识别）。
    expect(r.filter).toEqual({ scanned: 3, withText: 1, skipped: 1, failed: 1 });
    expect(Object.keys(r.results).sort()).toEqual(['a.jpg', 'c.jpg']);
    expect(local).toHaveBeenCalledTimes(2);
    expect(r.stage).toMatchObject({ total: 2, ok: 2, failed: 0 });
  });

  it('筛图模型不可用 → 整体跳过预筛选，全部送识别', async () => {
    const local = vi.fn(async () => ({ ok: true, text: '文字' }));
    const filter = vi.fn(async () => ({
      ok: false as const,
      error: '未下载筛图模型',
      unavailable: true,
    }));
    const r = await ocrFoundImages(scan([pic('a.jpg'), pic('b.jpg')]), dir, {
      filter,
      local,
      filterConcurrency: 1,
    });
    expect(r.filter?.unavailable).toBe(true);
    expect(local).toHaveBeenCalledTimes(2);
    expect(r.stage.total).toBe(2);
  });

  it('在线优先、从新到旧；在线成功的图不再跑本地', async () => {
    const order: string[] = [];
    const online = vi.fn(async (req: { fileName: string }) => {
      order.push(req.fileName);
      return { ok: true as const, text: `在线-${req.fileName}`, blocks: [{ text: 'x' }] };
    });
    const local = vi.fn(async () => ({ ok: true, text: '本地' }));
    const s = scan([
      pic('old.jpg', { sendTime: 100 }),
      pic('new.jpg', { sendTime: 900 }),
      pic('mid.jpg', { sendTime: 500 }),
    ]);
    const r = await ocrFoundImages(s, dir, { online, local, onlineConcurrency: 1 });

    expect(order).toEqual(['new.jpg', 'mid.jpg', 'old.jpg']);
    expect(local).not.toHaveBeenCalled();
    expect(r.results['new.jpg']).toMatchObject({ source: 'oidb', text: '在线-new.jpg' });
    expect(r).toMatchObject({ total: 3, ok: 3, online: 3, local: 0, failed: 0 });
  });

  it('在线连续失败到上限 → 剩下的（含被放弃的）全部回退本地模型', async () => {
    const onlineCalls: string[] = [];
    const online = vi.fn(async (req: { fileName: string }) => {
      onlineCalls.push(req.fileName);
      return { ok: false as const, error: '服务端取不到图' };
    });
    const local = vi.fn(async (path: string) => ({ ok: true, text: `本地-${path.slice(-5)}` }));
    // 12 张：连败上限 3 → 在线只试前 3 张，剩下 9 张回退本地。
    const items = Array.from({ length: 12 }, (_v, i) =>
      pic(`p${String(i).padStart(2, '0')}.jpg`, { sendTime: 1000 - i }),
    );
    const logs: string[] = [];
    const r = await ocrFoundImages(scan(items), dir, {
      online,
      local,
      onlineConcurrency: 1,
      onlineFailureLimit: 3,
      onLog: (text) => logs.push(text),
    });

    expect(onlineCalls).toEqual(['p00.jpg', 'p01.jpg', 'p02.jpg']);
    expect(local).toHaveBeenCalledTimes(12);
    expect(r).toMatchObject({ total: 12, ok: 12, online: 0, local: 12, failed: 0 });
    expect(logs.some((l) => l.includes('判定在线那条腿不可用'))).toBe(true);
  });

  it('在线成功但一个字都没识别出来 → 记空结果，不再送本地', async () => {
    const online = vi.fn(async () => ({ ok: true as const, text: '   ', blocks: [] }));
    const local = vi.fn(async () => ({ ok: true, text: '本地' }));
    const r = await ocrFoundImages(scan([pic('a.jpg')]), dir, { online, local });
    expect(local).not.toHaveBeenCalled();
    expect(r.results['a.jpg']).toEqual({ text: '', source: 'oidb' });
    expect(r).toMatchObject({ total: 1, ok: 0, online: 0, failed: 0 });
  });

  it('本机没有本体、还能下载的图：只送在线；在线失败记失败（本地无从下手）', async () => {
    const onlineCalls: string[] = [];
    const online = vi.fn(async (req: { fileName: string }) => {
      onlineCalls.push(req.fileName);
      return req.fileName === 'gone.jpg'
        ? { ok: false as const, error: '服务端已经取不到这张图了' }
        : { ok: true as const, text: '取到了' };
    });
    const local = vi.fn(async () => ({ ok: true, text: '本地' }));
    const s = scan([pic('here.jpg')], [missingPic('gone.jpg', 500), missingPic('fresh.jpg', 900)]);
    const r = await ocrFoundImages(s, dir, { online, local, onlineConcurrency: 1 });

    // 两张没本体的按新→旧送在线；本机有本体的那张在线成了，不必再跑本地。
    expect(onlineCalls).toEqual(['here.jpg', 'fresh.jpg', 'gone.jpg']);
    expect(local).not.toHaveBeenCalled();
    expect(r.results['fresh.jpg']).toMatchObject({ source: 'oidb', text: '取到了' });
    expect(r.onlineOnly).toBe(2);
    expect(r.stage.failed).toBe(1);
    expect(r.stage.failures?.[0]).toMatchObject({ fileName: 'gone.jpg', stage: 'ocr' });
  });

  it('没有在线、也没有本地模型 → 全部记失败，ocr.json 仍写出稳定形状', async () => {
    const r = await ocrFoundImages(scan([pic('a.jpg')]), dir, {});
    expect(r.stage).toMatchObject({ total: 1, ok: 0, failed: 1 });
    const artifact = readArtifact();
    expect(artifact.images).toEqual({});
    expect(artifact.stats).toMatchObject({ total: 1, ok: 0, failed: 1 });
  });

  it('ocr.json 记录文字 + 像素坐标框 + 来源统计', async () => {
    const blocks = [
      { text: '第一行', quad: { points: [] }, rect: { left: 1, top: 2, right: 3, bottom: 4 } },
    ];
    // 只有最新的那张在线成功（模拟「越新的越可能没过期」），其余回退本地。
    const online = vi.fn(async (req: { fileName: string }) =>
      req.fileName === 'c.jpg'
        ? { ok: true as const, text: '第一行', blocks }
        : { ok: false as const, error: '服务端取不到图' },
    );
    const local = vi.fn(async () => ({ ok: true, text: '本地文字', elapsedMs: 1200 }));
    const s = scan([
      pic('a.jpg', { sendTime: 100 }),
      pic('b.jpg', { sendTime: 200 }),
      pic('c.jpg', { sendTime: 300 }),
    ]);
    const r = await ocrFoundImages(s, dir, { online, local, onlineConcurrency: 1 });
    expect(r.online).toBe(1);
    expect(r.local).toBe(2);

    const artifact = readArtifact();
    expect(artifact.images['c.jpg']).toMatchObject({ text: '第一行', source: 'oidb', blocks });
    expect(artifact.images['b.jpg']).toMatchObject({
      text: '本地文字',
      source: 'local',
      elapsedMs: 1200,
    });
    expect(artifact.stats).toMatchObject({ total: 3, ok: 3, online: 1, local: 2, failed: 0 });
  });

  it('一张候选都没有时也写出 ocr.json', async () => {
    const r = await ocrFoundImages(scan([]), dir, {});
    expect(r.stage).toEqual({ total: 0, ok: 0, failed: 0 });
    expect(readArtifact().images).toEqual({});
  });

  it('产物 → 回写闭环：ocr.json 的 images 段直接喂给 rewriteOcrTexts', async () => {
    const local = vi.fn(async (path: string) =>
      path.endsWith('a.jpg') ? { ok: true, text: '甲\n乙' } : { ok: false, error: '空白图' },
    );
    const r = await ocrFoundImages(scan([pic('a.jpg'), pic('b.jpg')]), dir, { local });
    expect(r.stage).toMatchObject({ total: 2, ok: 1, failed: 1 });

    const txt = join(dir, 'out.txt');
    writeFileSync(txt, '10001: [图片: a.jpg → media/image/a.jpg] 和 [图片: b.jpg]\n', 'utf-8');
    const stats = rewriteOcrTexts([txt], readArtifact().images);
    expect(readFileSync(txt, 'utf-8')).toBe(
      '10001: [图片 → media/image/a.jpg] 甲 乙 和 [图片: b.jpg]\n',
    );
    expect(stats).toEqual({ files: 1, replaced: 1, skipped: 0 });
  });
});

describe('ocrFoundImages + 结果缓存', () => {
  const MD5_A = 'a'.repeat(32);
  const MD5_B = 'b'.repeat(32);

  /** 一张「元素里带 md5」的图片引用（缓存键就是它）。 */
  function picMd5(md5: string, extra: Partial<MediaRef> = {}): MediaRef {
    const base = pic(`${md5}.jpg`, extra);
    return {
      ...base,
      ocr: { ...base.ocr!, md5 },
    };
  }

  it('缓存命中：筛图 / 在线 / 本地一条都不跑，结果标 cached', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(MD5_A, 'oidb', {
      text: '以前在线识别过',
      frame: { width: 800, height: 600, variant: 'original' },
      lang: 'zh',
    });

    const filter = vi.fn(async () => ({ ok: true as const, hasText: true, boxes: 2 }));
    const online = vi.fn(async () => ({ ok: true as const, text: '在线' }));
    const local = vi.fn(async () => ({ ok: true as const, text: '本地' }));
    const r = await ocrFoundImages(scan([picMd5(MD5_A)]), dir, {
      cache,
      filter,
      filterModelId: () => 'ppocr-v6-det-tiny',
      online,
      local,
    });

    expect(filter).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(r.cached).toBe(1);
    expect(r.results[`${MD5_A}.jpg`]).toMatchObject({
      text: '以前在线识别过',
      source: 'oidb',
      cached: true,
      width: 800,
      height: 600,
    });
    // 产物与统计口径：total 是「这次真跑的」，cached 单独一档
    expect(readArtifact().stats).toMatchObject({ total: 0, cached: 1, ok: 1 });
    expect(r.stage).toMatchObject({ total: 0, ok: 1, failed: 0 });
  });

  it('跑过的图落进缓存：第二次同一张图直接命中（本地模型不再跑）', async () => {
    const cache = new OcrResultCache(dir);
    const local = vi.fn(async () => ({
      ok: true as const,
      text: '本地结果',
      width: 800,
      height: 600,
      modelId: 'ppocr-v5-mobile',
      elapsedMs: 2500,
    }));

    const first = await ocrFoundImages(scan([picMd5(MD5_B)]), dir, { cache, local });
    expect(first).toMatchObject({ local: 1, cached: 0 });
    expect(await cache.getText(MD5_B)).toMatchObject({
      text: '本地结果',
      source: 'local',
      modelId: 'ppocr-v5-mobile',
      frame: { width: 800, height: 600, variant: 'original' },
    });

    const second = await ocrFoundImages(scan([picMd5(MD5_B)]), dir, { cache, local });
    expect(local).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ cached: 1, local: 0 });
    expect(second.results[`${MD5_B}.jpg`]).toMatchObject({ cached: true, text: '本地结果' });
  });

  it('本机没有本体、只能走在线的图：缓存命中时连网都不用出', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(MD5_A, 'oidb', {
      text: '过期图的老结果',
      frame: { width: 800, height: 600, variant: 'original' },
    });
    const online = vi.fn(async () => ({ ok: true as const, text: '在线' }));
    const r = await ocrFoundImages(scan([], [missingPic(`${MD5_A}.jpg`, 100)]), dir, {
      cache,
      online,
    });
    expect(online).not.toHaveBeenCalled();
    expect(r).toMatchObject({ cached: 1, online: 0, onlineOnly: 0, ok: 1 });
  });

  it('筛图结论按模型缓存：同模型第二次不跑筛图，换模型要重判', async () => {
    const cache = new OcrResultCache(dir);
    const filter = vi.fn(async () => ({ ok: true as const, hasText: true, boxes: 5 }));
    const local = vi.fn(async () => ({
      ok: true as const,
      text: '文字',
      modelId: 'ppocr-v5-mobile',
    }));
    const first = await ocrFoundImages(scan([picMd5(MD5_A)]), dir, {
      cache,
      filter,
      filterModelId: () => 'ppocr-v6-det-tiny',
      local,
      filterConcurrency: 1,
    });
    expect(filter).toHaveBeenCalledTimes(1);
    expect(first.filter).toMatchObject({ withText: 1, skipped: 0 });

    // 同一模型、不同图也能吃到「有文字」的结论？不行 —— 缓存按图寻址，这里换个 md5 再验
    const again = await ocrFoundImages(scan([picMd5(MD5_A)]), dir, {
      cache,
      filter,
      filterModelId: () => 'ppocr-v6-det-tiny',
      local,
      filterConcurrency: 1,
    });
    // 第二张图（同一张）筛图与识别都命中缓存：一个模型都不跑
    expect(filter).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ cached: 1, local: 0 });

    // 换了筛图模型：结论不认，重新判
    await ocrFoundImages(scan([picMd5(MD5_B)]), dir, {
      cache,
      filter,
      filterModelId: () => 'ppocr-v5-det-mobile',
      local,
      filterConcurrency: 1,
    });
    expect(filter).toHaveBeenCalledTimes(2);
  });
});

describe('ocrFoundImages + 流水线 / 进度', () => {
  /** 一个能手动解开的 promise（卡住某张图的筛图 / 在线请求）。 */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('筛图与在线并行：第一张筛完就发在线，不等整批筛完', async () => {
    const gate = deferred(); // 卡住最后一张（最旧）的筛图
    const filter = vi.fn(async (path: string) => {
      if (path.endsWith('late.jpg')) await gate.promise;
      return { ok: true as const, hasText: true };
    });
    const onlineCalls: string[] = [];
    const online = vi.fn(async (req: { fileName: string }) => {
      onlineCalls.push(req.fileName);
      return { ok: true as const, text: `在线-${req.fileName}` };
    });
    const s = scan([
      pic('a.jpg', { sendTime: 300 }),
      pic('b.jpg', { sendTime: 200 }),
      pic('late.jpg', { sendTime: 100 }),
    ]);
    const run = ocrFoundImages(s, dir, {
      filter,
      online,
      filterConcurrency: 1,
      onlineConcurrency: 2,
    });

    // 筛图还卡在最后一张（第 3 次调用在飞）时，前两张的在线请求已经发出去了。
    // 旧实现是「整批筛完才开始在线」，这里 online 会是 0 次。
    await vi.waitFor(() => expect(online).toHaveBeenCalledTimes(2));
    expect(filter).toHaveBeenCalledTimes(3);
    expect(onlineCalls).toEqual(['a.jpg', 'b.jpg']);

    gate.resolve();
    const r = await run;
    expect(r).toMatchObject({ total: 3, ok: 3, online: 3, local: 0, failed: 0 });
  });

  it('单张回包超时不算「这条腿不行了」：后面的图照样试在线', async () => {
    const calls: string[] = [];
    const online = vi.fn(async (req: { fileName: string }) => {
      calls.push(req.fileName);
      // 文案来自 native：send_oidb_packet failed: SSO 请求超时：OidbSvcTrpcTcp.0xe07_0
      return req.fileName === 'p00.jpg'
        ? { ok: false as const, error: 'SSO 请求超时：OidbSvcTrpcTcp.0xe07_0（seq=1792136378）' }
        : { ok: true as const, text: '取到了' };
    });
    const items = [
      pic('p00.jpg', { sendTime: 300 }),
      pic('p01.jpg', { sendTime: 200 }),
      pic('p02.jpg', { sendTime: 100 }),
    ];
    const r = await ocrFoundImages(scan(items), dir, {
      online,
      onlineConcurrency: 1,
      // 连败上限压到 1：旧语义下第一个超时就会把剩下两张一起放弃。
      onlineFailureLimit: 1,
    });

    expect(calls).toEqual(['p00.jpg', 'p01.jpg', 'p02.jpg']);
    expect(r).toMatchObject({ total: 3, ok: 2, online: 2, failed: 1, timeouts: 1 });
    expect(readArtifact().stats.timeouts).toBe(1);
  });

  it('进度：一上来就有真分母，筛掉的图从分母里减掉，在线每张落地都推进', async () => {
    const seen: Array<[number, number]> = [];
    const filter = vi.fn(async (path: string) => ({
      ok: true as const,
      hasText: !path.endsWith('b.jpg'),
    }));
    const online = vi.fn(async () => ({ ok: true as const, text: '文字' }));
    const s = scan([pic('a.jpg'), pic('b.jpg'), pic('c.jpg')]);
    const r = await ocrFoundImages(s, dir, {
      filter,
      online,
      filterConcurrency: 1,
      onlineConcurrency: 1,
      onProgress: (done, total) => seen.push([done, total]),
    });

    // 界面上「一直 0%」的反面：分母是真张数，不是 0/0。
    expect(seen[0]).toEqual([0, 3]);
    expect(seen).toContainEqual([0, 2]); // b.jpg 被筛掉，分母减一
    expect(seen.at(-1)).toEqual([2, 2]);
    expect(r.stage.total).toBe(2);
  });

  it('心跳：在线还在等回包时也会说话（默认 30 s 至少一条）', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const logs: string[] = [];
      const online = vi.fn(async () => {
        await gate.promise;
        return { ok: true as const, text: '文字' };
      });
      const run = ocrFoundImages(scan([pic('a.jpg')]), dir, {
        online,
        onLog: (text) => logs.push(text),
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(logs.some((l) => l.includes('在线识别进行中'))).toBe(true);

      gate.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});
