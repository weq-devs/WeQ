import { expect, it } from 'vitest';
import { groupProfileRows, groupJoinedDate } from '../src/renderer/src/lib/groupProfileRows';
import { withLocalGroupJoinTimes, sortGroups } from '../src/renderer/src/lib/contactListOrder';
import { groupSortDetail } from '../src/renderer/src/lib/contactDirectoryPresentation';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
import type { GroupProfileExtras } from '@weq/protocol';
const base: GroupProfileExtras = {
  grade: 0,
  activeMemberCount: 0,
  freezeState: 0,
  freezeReason: 0,
  portraitSequence: null,
  portrait: null,
};
it('明确零值正常显示，未知不冒充零值，不添加统计时间窗口或星级', () => {
  expect(groupProfileRows(base)).toEqual([
    ['群等级', '0'],
    ['活跃成员', '0 人'],
    ['冻结状态', '正常'],
  ]);
  // 契约 §3：没有可信值时整行不出（旧行为是写「未知」占位）。
  expect(groupProfileRows(null)).toEqual([]);
});
it('本人时间按北京时间显示，旧缓存和无效占位不显示日期', () => {
  expect(groupJoinedDate(1704038407)).toBe('2024/1/1 00:00:07');
  expect(groupProfileRows({ ...base, joinedAt: 1704038407 })[0]).toEqual([
    '我的入群时间',
    '2024/1/1 00:00:07',
  ]);
  for (const value of [undefined, null, 0, 1, Number.NaN, 0x100000000])
    expect(groupJoinedDate(value)).toBeNull();
});
it('入群排序与统一指标一致，本地只补缺失，不用较大值覆盖新时间', () => {
  const rows = {
    'group:1': { joinedAt: { value: 100, state: 'ready' as const, attemptedAt: 9, updatedAt: 9 } },
  };
  const result = withLocalGroupJoinTimes(rows, { '1': 200, '2': 300, '3': 1 });
  expect(result['group:1']).toBe(rows['group:1']);
  expect(result['group:2']?.joinedAt?.value).toBe(300);
  expect(result['group:3']).toBeUndefined();
  expect(rows).not.toHaveProperty('group:2');
});
it('旧指标中的 1 占位也不排序成最早入群，不显示 1970 年日期', () => {
  const items = ['1', '2'].map(
    (id) =>
      ({ id, type: 'group', group: { id, name: id, identityValue: id } }) as GroupConversation,
  );
  const rows = {
    'group:1': { joinedAt: { value: 1, state: 'ready' as const, attemptedAt: 1 } },
    'group:2': { joinedAt: { value: 1704038407, state: 'ready' as const, attemptedAt: 1 } },
  };
  for (const descending of [false, true])
    expect(sortGroups(items, 'joinedAt', descending, rows).map((g) => g.id)).toEqual(['2', '1']);
  expect(groupSortDetail(items[0]!.group, 'joinedAt', rows)?.text).not.toContain('1970');
});
it('冻结原因与未知状态保留代码；头像元数据不是历史头像 URL', () => {
  expect(
    groupProfileRows({
      ...base,
      freezeState: 2,
      freezeReason: 99,
      portraitSequence: 0,
      portrait: { count: 0, defaultId: 0, pictures: [] },
    }),
  ).toEqual([
    ['群等级', '0'],
    ['活跃成员', '0 人'],
    ['冻结状态', '状态码 2'],
    // 协议/调试字段带 technical 标记，调用方据此收进「技术详情」折叠区。
    ['冻结原因代码', '99', true],
    ['头像数量', '0', true],
    ['默认头像编号', '0', true],
    ['头像版本', '0', true],
  ]);
});
