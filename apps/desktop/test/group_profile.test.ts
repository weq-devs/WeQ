import { expect, it } from 'vitest';
import { groupProfileRows } from '../src/renderer/src/lib/groupProfileRows';
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
    ['群 grade', '0'],
    ['活跃成员', '0 人'],
    ['冻结状态', '正常'],
  ]);
  expect(groupProfileRows(null)).toEqual([
    ['群 grade', '未知'],
    ['活跃成员', '未知'],
    ['冻结状态', '未知'],
  ]);
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
    ['群 grade', '0'],
    ['活跃成员', '0 人'],
    ['冻结状态', '状态码 2'],
    ['冻结原因代码', '99'],
    ['头像数量', '0'],
    ['默认头像编号', '0'],
    ['头像版本', '0'],
  ]);
});
