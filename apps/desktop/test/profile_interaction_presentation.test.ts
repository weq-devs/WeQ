import { expect, it } from 'vitest';
import { profileLikeSummary } from '../src/renderer/src/lib/profileInteractionPresentation';
it('摘要使用真实总数和等，未知数量不补数', () => {
  expect(profileLikeSummary(['张三', '李四'], '28')).toBe('张三、李四等 28 人点赞');
  expect(profileLikeSummary(['张三'], null)).toBe('张三等人点赞');
  expect(profileLikeSummary(['张三'], '1')).toBe('张三点赞');
  expect(profileLikeSummary([], '0')).toBe('0 人点赞');
  expect(profileLikeSummary([], null)).toBe('');
});
