import { expect, it } from 'vitest';
import {
  CACHE_DAY_MS,
  contactCacheFields,
  shouldOfferContactRefresh,
} from '../src/renderer/src/lib/contactCachePolicy';
import type { ContactMetricRows } from '@weq/service';
const now = 20 * CACHE_DAY_MS;
const cell = (updatedAt: number) => ({
  value: 1,
  updatedAt,
  attemptedAt: updatedAt,
  state: 'ready' as const,
});
it('分别判断切换的排序或分组，不把另一控件的缓存依赖带进来', () => {
  expect(contactCacheFields('sort', 'level')).toEqual(['level']);
  expect(contactCacheFields('grouping', 'direction')).toEqual(['direction']);
  for (const local of [
    'none',
    'qq',
    'birthYear',
    'gender',
    'location',
    'relation',
    'constellation',
  ]) {
    expect(
      shouldOfferContactRefresh({}, contactCacheFields('grouping', local), [['friend:a']], now),
    ).toBe(false);
  }
  expect(contactCacheFields('sort', 'age')).toEqual([]);
});
it('每个好友独立维护时间，新刷新的好友不能掩盖另一位超过七天的缓存', () => {
  const rows: ContactMetricRows = {
    'friend:new': { level: cell(now) },
    'friend:old': { level: cell(now - 8 * CACHE_DAY_MS) },
  };
  expect(shouldOfferContactRefresh(rows, ['level'], [['friend:new'], ['friend:old']], now)).toBe(
    true,
  );
  expect(shouldOfferContactRefresh(rows, ['level'], [['friend:new']], now)).toBe(false);
});
it('每个群独立维护时间，恰好七天不询问，超过七天才询问', () => {
  const rows: ContactMetricRows = {
    'group:a': { friendCount: cell(now - 7 * CACHE_DAY_MS) },
    'group:b': { friendCount: cell(now - 7 * CACHE_DAY_MS - 1) },
  };
  expect(shouldOfferContactRefresh(rows, ['friendCount'], [['group:a']], now)).toBe(false);
  expect(shouldOfferContactRefresh(rows, ['friendCount'], [['group:a'], ['group:b']], now)).toBe(
    true,
  );
});
it('UID 和 QQ 号属于同一好友的别名，不误判缺失；空列表不询问', () => {
  expect(
    shouldOfferContactRefresh(
      { 'friend:u_a': { likeCount: cell(now) } },
      ['likeCount'],
      [['friend:12345', 'friend:u_a']],
      now,
    ),
  ).toBe(false);
  expect(shouldOfferContactRefresh({}, ['likeCount'], [], now)).toBe(false);
  expect(shouldOfferContactRefresh({}, ['likeCount'], [['friend:12345', 'friend:u_a']], now)).toBe(
    true,
  );
});
