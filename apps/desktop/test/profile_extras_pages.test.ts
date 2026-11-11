import { expect, it } from 'vitest';
import {
  extrasPageWarning,
  mergeExtrasPages,
  nextExtrasCursor,
} from '../src/renderer/src/lib/profileExtrasPages';
const page = (ids: string[], nextCursor: string | null, hasMore = true) => ({
  items: ids.map((id) => ({ id })),
  nextCursor,
  hasMore,
  paginationError: null,
});
it('跨页按稳定标识去重', () =>
  expect(mergeExtrasPages([page(['a', 'b'], '1'), page(['b', 'c'], null, false)])).toEqual([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]));
it('空页和短页只看服务端结束标志', () => {
  const pages = [page([], 'next')];
  expect(nextExtrasCursor(pages[0]!, pages)).toBe('next');
});
it('重复游标停止续页，保留所有内容', () => {
  const pages = [page(['a'], 'next'), page(['b'], 'next')];
  expect(nextExtrasCursor(pages[1]!, pages)).toBeUndefined();
  expect(extrasPageWarning(pages)).toContain('重复');
  expect(mergeExtrasPages(pages)).toHaveLength(2);
});
it('有游标但重复整个页面也停止，不无限请求', () => {
  const pages = [page(['a'], '1'), page(['a'], '2')];
  expect(extrasPageWarning(pages)).toContain('没有返回新的');
});
it('已结束且缺 cookie 的空页正常终止', () => {
  const pages = [page([], null, false)];
  expect(extrasPageWarning(pages)).toBeNull();
  expect(nextExtrasCursor(pages[0]!, pages)).toBeUndefined();
});
