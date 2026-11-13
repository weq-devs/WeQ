import { expect, it } from 'vitest';
import type { HistoricalAvatar } from '@weq/protocol';
import { sortHistoricalAvatars } from '../src/renderer/src/lib/avatarHistory';
import { mergeExtrasPages, extrasPageWarning } from '../src/renderer/src/lib/profileExtrasPages';

const item = (
  id: string,
  firstUsedAt: number | null,
  lastUsedAt: number | null,
): HistoricalAvatar => ({
  id,
  firstUsedAt,
  lastUsedAt,
  faceFlag: 31,
  fileSize: 100,
  url: '',
  thumbnailUrl: '',
});
it('两个时间独立排序，同时间稳定，未知无论升降均最后', () => {
  const rows = [
    item('old-upload', 1, 200),
    item('b', 100, 100),
    item('a', 100, 100),
    item('unknown', null, null),
  ];
  expect(sortHistoricalAvatars(rows, 'firstUsedAt', true).map((x) => x.id)).toEqual([
    'old-upload',
    'a',
    'b',
    'unknown',
  ]);
  expect(sortHistoricalAvatars(rows, 'firstUsedAt', false).map((x) => x.id)).toEqual([
    'a',
    'b',
    'old-upload',
    'unknown',
  ]);
  expect(sortHistoricalAvatars(rows, 'lastUsedAt', false).map((x) => x.id)).toEqual([
    'old-upload',
    'a',
    'b',
    'unknown',
  ]);
  expect(sortHistoricalAvatars(rows, 'lastUsedAt', true).map((x) => x.id)).toEqual([
    'a',
    'b',
    'old-upload',
    'unknown',
  ]);
  expect(rows[0]?.id).toBe('old-upload');
});
it('边界重复资源合并，新页保留新资源', () => {
  expect(
    mergeExtrasPages([
      { items: [item('a', 1, 3), item('b', 2, 2)] },
      { items: [item('b', 2, 2), item('c', 3, 1)] },
    ]),
  ).toHaveLength(3);
});
it('游标循环与无新增页停止自动读取，不假装完整', () => {
  const page = { items: [item('a', 1, 2)], nextCursor: 2, hasMore: true, paginationError: null };
  expect(extrasPageWarning([page, page])).toContain('重复');
  expect(extrasPageWarning([page, { ...page, nextCursor: 1 }])).toContain('没有返回新的条目');
});
