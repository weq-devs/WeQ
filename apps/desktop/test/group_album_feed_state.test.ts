import { expect, it } from 'vitest';
import type { GroupAlbumFeedPage } from '@weq/service';
import { mergeGroupAlbumFeedPages } from '../src/renderer/src/lib/groupAlbumFeedState';
const comment = (id: string, content = id) => ({
  id,
  content,
  time: 1,
  author: { uin: '10001', name: '合成' },
  replies: [],
  totalReplies: 0,
});
const page = (): GroupAlbumFeedPage => ({
  groupCode: '123456',
  albumId: 'synthetic',
  albumName: '合成',
  batchId: '1700000000',
  author: { uin: '10001', name: '合成' },
  time: 1,
  media: [],
  comments: [],
  totalComments: 2,
  totalMedia: 0,
  hasMore: false,
  nextCursor: null,
});
it('分页按服务器顺序去重并保留回复，不修改旧页', () => {
  const first = { ...page(), comments: [{ ...comment('c1'), replies: [comment('r1')] }] },
    next = {
      ...page(),
      comments: [{ ...comment('c1', '更新正文'), replies: [comment('r2')] }, comment('c2')],
    };
  const before = JSON.stringify(first),
    merged = mergeGroupAlbumFeedPages(first, next);
  expect(merged.comments.map((row) => row.id)).toEqual(['c1', 'c2']);
  expect(merged.comments[0]?.replies.map((row) => row.id)).toEqual(['r1', 'r2']);
  expect(merged.comments[0]?.content).toBe('更新正文');
  expect(JSON.stringify(first)).toBe(before);
});
it.each(['groupCode', 'albumId', 'batchId'] as const)('不合并不同%s的分页', (key) => {
  expect(() => mergeGroupAlbumFeedPages(page(), { ...page(), [key]: 'other' })).toThrow(
    '目标已变化',
  );
});
