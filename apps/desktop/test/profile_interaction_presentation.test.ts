import { expect, it } from 'vitest';
import { profileLikeSummary } from '../src/renderer/src/lib/profileInteractionPresentation';
it('列表底部与空间一致只显示人数，未知总数不补数', () => {
  expect(profileLikeSummary(2, '28')).toBe('28 人赞过');
  expect(profileLikeSummary(1, null)).toBe('已显示 1 人');
  expect(profileLikeSummary(1, '1')).toBe('1 人赞过');
  expect(profileLikeSummary(0, '0')).toBe('还没有人赞过');
  expect(profileLikeSummary(0, null)).toBe('');
  expect(profileLikeSummary(0, undefined)).toBe('');
  expect(profileLikeSummary(2, undefined)).toBe('已显示 2 人');
});
