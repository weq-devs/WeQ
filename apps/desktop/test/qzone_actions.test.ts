import { expect, it } from 'vitest';
import {
  QzoneRelatedRound,
  qzoneForwardDraft,
  qzoneSelfLiked,
} from '../src/renderer/src/lib/qzoneActions';

it.each([true, false])('明确本人状态 %s 优先于名单及覆盖情况', (selfLiked) => {
  expect(
    qzoneSelfLiked(
      {
        selfLiked,
        likes: selfLiked ? [] : [{ uin: '10001', nickname: '合成自己', time: 0, customItemId: '' }],
        coverage: 'observed',
      },
      '10001',
    ),
  ).toBe(selfLiked);
});

it('兼容旧接口：找到本人可确认点赞，只有完整名单可确认未点赞', () => {
  expect(
    qzoneSelfLiked(
      {
        likes: [{ uin: '10001', nickname: '合成自己', time: 0, customItemId: '' }],
        coverage: 'observed',
      },
      '10001',
    ),
  ).toBe(true);
  expect(qzoneSelfLiked({ likes: [], coverage: 'complete' }, '10001')).toBe(false);
  expect(qzoneSelfLiked({ likes: [], coverage: 'observed', selfLiked: null }, '10001')).toBeNull();
  expect(qzoneSelfLiked({ likes: [], coverage: 'unobserved' }, '10001')).toBeNull();
  expect(qzoneSelfLiked(null, '10001')).toBeNull();
});

it('引用上一人文案，保留原始文字；关闭或无文案时不预填', () => {
  expect(qzoneForwardDraft(true, '上一人\n文案')).toBe('//：上一人\n文案');
  expect(qzoneForwardDraft(false, '文案')).toBe('');
  expect(qzoneForwardDraft(true, '  ')).toBe('');
});

it('每轮最多五次，未用完的滚动不叠加额度，耗尽后只有向下滚动重开', () => {
  const round = new QzoneRelatedRound();
  expect(round.take()).toBe(true);
  expect(round.scrollDown()).toBe(false);
  for (let index = 1; index < round.limit; index++) expect(round.take()).toBe(true);
  expect(round.take()).toBe(false);
  expect(round.take()).toBe(false);
  expect(round.scrollDown()).toBe(true);
  for (let index = 0; index < round.limit; index++) expect(round.take()).toBe(true);
  expect(round.take()).toBe(false);
});
