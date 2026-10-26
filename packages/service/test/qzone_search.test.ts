import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContentSearchStore,
  type ContentSearchCategory,
  type ContentSearchRecord,
} from '../src/account/content_search';
import { UnifiedSearchService } from '../src/account/unified_search';
import { QZONE_SEARCH_CATEGORIES, qzoneSearchCoverage } from '../src/account/search_policy';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

it('合并空间覆盖保留空缓存、不可用、回收及尚未保存的状态', () => {
  expect(qzoneSearchCoverage({})).toBeUndefined();
  expect(
    qzoneSearchCoverage({
      qzonePost: {
        scope: 'observed-cache',
        records: 0,
        limited: false,
        updatedAt: null,
        available: false,
      },
      otherQzoneAlbum: {
        scope: 'observed-cache',
        records: 0,
        limited: true,
        updatedAt: null,
        available: false,
        persistenceFailed: true,
      },
    }),
  ).toEqual({
    scope: 'observed-cache',
    records: 0,
    limited: true,
    updatedAt: null,
    available: false,
    persistenceFailed: true,
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-qzone-search-'));
  const store = new ContentSearchStore(join(root, 'observed.json'));
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const records: ContentSearchRecord[] = [
    {
      target: { kind: 'qzonePost', uin: '10001', tid: 'same' },
      title: 'needle',
      content: '自己的说说',
      sourceName: '空间 10001',
      time: 10,
    },
    {
      target: { kind: 'qzonePost', uin: '10002', tid: 'same' },
      title: 'needle',
      content: '他人的说说',
      sourceName: '空间 10002',
      time: 30,
    },
    {
      target: { kind: 'qzoneAlbum', uin: '10001', albumId: 'same' },
      title: 'needle',
      content: '自己的相册',
      sourceName: '空间 10001',
      time: 20,
    },
    {
      target: { kind: 'qzoneAlbum', uin: '10002', albumId: 'same' },
      title: 'needle',
      content: '他人的相册',
      sourceName: '空间 10002',
      time: 40,
    },
    {
      target: { kind: 'qzonePost', uin: '10002', tid: 'prefix' },
      title: 'needle-more',
      content: '',
      sourceName: '空间 10002',
      time: 100,
    },
    {
      target: { kind: 'qzonePost', uin: '10001', tid: 'body' },
      title: '正文命中',
      content: 'needle',
      sourceName: '空间 10001',
      time: 200,
    },
  ];
  store.remember(records);
  const searchContent = vi.fn(
    (category: ContentSearchCategory, keyword: string, limit: number, offset: number) =>
      store.search(category, keyword, limit, offset, '10001'),
  );
  return {
    store,
    records,
    searchContent,
    service: new UnifiedSearchService({} as AccountSession, { searchContent }),
  };
}

it('空间一次选择覆盖自己和他人的说说、相册，不扫描聊天来源，空范围不查询', async () => {
  const f = fixture();
  const indexes = vi.spyOn(f.service, 'ensureIndexes');
  const result = await f.service.slowSearch('needle', 3, ['qzone']);
  expect(f.searchContent.mock.calls.map(([category]) => category)).toEqual(QZONE_SEARCH_CATEGORIES);
  expect(result.contentHits).toHaveLength(6);
  expect(new Set(result.contentHits?.map((hit) => hit.id)).size).toBe(6);
  expect(indexes).not.toHaveBeenCalled();
  f.searchContent.mockClear();
  await f.service.slowSearch('needle', 3, []);
  expect(f.searchContent).not.toHaveBeenCalled();
});

it('空间更多按相关度和时间混合分页，保留同 id 不同作者及说说相册身份', async () => {
  const f = fixture();
  const pages = [];
  for (const offset of [0, 2, 4])
    pages.push(await f.service.moreSearch('qzone', 'needle', offset, 2));
  expect(pages.map((page) => [page.total, page.hasMore])).toEqual([
    [6, true],
    [6, true],
    [6, false],
  ]);
  expect(
    pages.flatMap((page) => page.items.map((hit) => ('target' in hit ? hit.target : null))),
  ).toEqual([
    f.records[3]!.target,
    f.records[1]!.target,
    f.records[2]!.target,
    f.records[0]!.target,
    f.records[4]!.target,
    f.records[5]!.target,
  ]);
  expect(pages[0]?.coverage).toMatchObject({ scope: 'observed-cache', records: 6, limited: false });
  expect((await f.service.moreSearch('qzonePost', 'needle', 0, 10)).total).toBe(2);
});

it('空间单个来源失败仍返回其他来源，更多查询失败可重试而不假报完整总数', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  f.searchContent.mockImplementation((category, keyword, limit, offset) => {
    if (category === 'otherQzoneAlbum') throw new Error('合成相册失败');
    return f.store.search(category, keyword, limit, offset, '10001');
  });
  try {
    const result = await f.service.slowSearch('needle', 3, ['qzone']);
    expect(result.failedCategories).toEqual(['otherQzoneAlbum']);
    expect(result.contentHits).toHaveLength(5);
    await expect(f.service.moreSearch('qzone', 'needle', 0, 2)).rejects.toThrow('合成相册失败');
  } finally {
    log.mockRestore();
  }
});
