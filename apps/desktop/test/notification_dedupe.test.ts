import { expect, it } from 'vitest';
import { messageNotificationDedupe } from '../src/shared/notification_dedupe';
it('同一数据源群消息只认领一次，其他账号或会话序号独立', () => {
  const claim = messageNotificationDedupe();
  expect(claim('a', 'group', '20001', '1')).toBe(true);
  expect(claim('a', 'group', '20001', '1')).toBe(false);
  expect(claim('b', 'group', '20001', '1')).toBe(true);
  expect(claim('a', 'group', '20002', '1')).toBe(true);
});
it('失败认领可释放，历史缓存有界', () => {
  const claim = messageNotificationDedupe(2);
  claim('a', 'group', '1', '1');
  claim('a', 'group', '1', '2');
  claim('a', 'group', '1', '3');
  expect(claim('a', 'group', '1', '1')).toBe(true);
  expect(claim.release('a', 'group', '1', '3')).toBe(true);
  expect(claim('a', 'group', '1', '3')).toBe(true);
});
