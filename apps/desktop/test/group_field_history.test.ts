import { expect, it } from 'vitest';
import {
  contactHistoryFieldForLabel,
  groupFieldHistoryValue,
} from '../src/renderer/src/components/contactProfile/ContactFieldHistory';

it('群资料字段接入逐项历史，数字零值和业务单位保留', () => {
  expect(contactHistoryFieldForLabel.群地点).toBe('addressName');
  expect(contactHistoryFieldForLabel.群成员数).toBe('memberCount');
  expect(groupFieldHistoryValue('group:12345', undefined, 'memberCount', 0)).toBe('0 人');
  expect(groupFieldHistoryValue('group:12345', undefined, 'joinedAt', 1704038407)).toBe(
    '2024-01-01 00:00:07',
  );
  expect(groupFieldHistoryValue('group:12345', undefined, 'freezeState', 1)).toBe('已冻结');
});
it('群标签历史去重为业务标签，不暴露内部结构，不改变联系人或成员字段', () => {
  expect(
    groupFieldHistoryValue('group:12345', undefined, 'labels', {
      labels: ['同学', '音乐'],
      customLabels: ['音乐', '拼车'],
    }),
  ).toEqual(['同学', '音乐', '拼车']);
  expect(groupFieldHistoryValue('friend:u_peer', undefined, 'memberCount', 2)).toBe(2);
  expect(groupFieldHistoryValue('group:12345', 'u_peer', 'joinedAt', 1704038407)).toBe(1704038407);
});
