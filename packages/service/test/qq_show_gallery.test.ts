/**
 * QQ 秀展柜扫描（`scanQqShowGallery`）的离线单测。
 *
 * 用假的缓存实现模拟 CDN：给一个「存在的序号集合」，每个序号的字节由序号派生，
 * 于是同一序号永远同 md5、不同序号不同 md5。全程不联网、不碰真实照片。
 *
 * 覆盖：命中即推、连续空号判尾、中间缺号不误停、md5 去重、abort。
 */

import { expect, it } from 'vitest';
import {
  EMPTY_STOP,
  QQSHOW_GALLERY_START,
  scanQqShowGallery,
  type QqShowGalleryEvent,
} from '../src/account/qq_show_gallery';

/** 极简假缓存：URL 里解析出序号，命中就返回该序号派生的字节。 */
function fakeCache(present: Set<number>): { get: (url: string) => Promise<{ data: Buffer }> } {
  return {
    async get(url: string) {
      const match = /\/(\d+)\.png$/.exec(url);
      const revision = match ? Number(match[1]) : 0;
      if (!present.has(revision)) throw new Error('media upstream 404');
      // 用序号当字节内容 —— 相同序号 => 相同 md5。
      return { data: Buffer.from(`revision-${revision}`, 'utf8') };
    },
  };
}

async function run(present: Set<number>, signal?: AbortSignal) {
  const events: QqShowGalleryEvent[] = [];
  await scanQqShowGallery('123456789', {
    cache: fakeCache(present) as never,
    emit: (event) => events.push(event),
    ...(signal ? { signal } : {}),
  });
  return events;
}

it('从 101 起扫，连续 10 个空号才收尾', async () => {
  const present = new Set([101, 102, 103]);
  const events = await run(present);
  const items = events.filter((event) => event.kind === 'item');
  expect(items.map((event) => (event as { item: { revision: number } }).item.revision)).toEqual([
    101, 102, 103,
  ]);
  const done = events.at(-1)!;
  expect(done.kind).toBe('done');
  // 扫到 103 + EMPTY_STOP 为止，不多扫也提前不了。
  expect((done as { scanned: number }).scanned).toBe(103 + EMPTY_STOP);
  expect((done as { truncated: boolean }).truncated).toBe(false);
});

it('中间缺号不会误判结尾', async () => {
  // 107..110 缺号（实测过的形态），后面还有图。
  const present = new Set([101, 102, 103, 104, 105, 106, 111, 112]);
  const events = await run(present);
  const revisions = events
    .filter((event) => event.kind === 'item')
    .map((event) => (event as { item: { revision: number } }).item.revision);
  expect(revisions).toEqual([101, 102, 103, 104, 105, 106, 111, 112]);
});

it('内容相同的不同序号只出一张（md5 去重）', async () => {
  // 101 与 105 字节相同 —— 模拟「重复保存同一套形象」。
  const events: QqShowGalleryEvent[] = [];
  const cache = {
    async get(url: string) {
      const revision = Number(/\/(\d+)\.png$/.exec(url)?.[1] ?? 0);
      if (revision >= 101 && revision <= 105) {
        const body = revision === 101 || revision === 105 ? 'same' : `r${revision}`;
        return { data: Buffer.from(body, 'utf8') };
      }
      throw new Error('404');
    },
  };
  await scanQqShowGallery('123456789', { cache: cache as never, emit: (e) => events.push(e) });
  const revisions = events
    .filter((event) => event.kind === 'item')
    .map((event) => (event as { item: { revision: number } }).item.revision);
  expect(revisions).toEqual([101, 102, 103, 104]);
  expect((events.at(-1) as { found: number }).found).toBe(4);
});

it('一张都没有时也按连续 10 空收尾', async () => {
  const events = await run(new Set());
  expect(events.filter((event) => event.kind === 'item')).toHaveLength(0);
  const done = events.at(-1)!;
  expect((done as { scanned: number }).scanned).toBe(QQSHOW_GALLERY_START + EMPTY_STOP - 1);
});

it('abort 后立即收尾，且不再推新命中', async () => {
  const controller = new AbortController();
  const present = new Set([101, 102, 103, 104, 105, 106]);
  const events: QqShowGalleryEvent[] = [];
  const cache = {
    async get(url: string) {
      const revision = Number(/\/(\d+)\.png$/.exec(url)?.[1] ?? 0);
      // 第一批探测中一旦看到 102 就取消 —— 后续批次不应再继续。
      if (revision === 102) controller.abort();
      if (present.has(revision)) return { data: Buffer.from(`r${revision}`, 'utf8') };
      throw new Error('404');
    },
  };
  await scanQqShowGallery('123456789', {
    cache: cache as never,
    signal: controller.signal,
    emit: (event) => events.push(event),
  });
  const done = events.at(-1)!;
  expect(done.kind).toBe('done');
  expect((done as { truncated: boolean }).truncated).toBe(true);
});
