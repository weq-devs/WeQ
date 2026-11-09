import { expect, it, vi } from 'vitest';
import {
  readFreshGroupMemberPage,
  activeGroupMembers,
} from '../src/renderer/src/lib/groupMemberRefresh';

it('成员增减时丢弃在途旧分页，从首屏重读而不沿用偏移', async () => {
  let version = 0;
  const load = vi.fn(async (_offset: number) => {
    if (version === 0) {
      version++;
      return ['已退群'];
    }
    return ['新成员'];
  });
  expect(await readFreshGroupMemberPage(120, () => version, load)).toEqual({
    page: ['新成员'],
    offset: 0,
    version: 1,
  });
  expect(load.mock.calls).toEqual([[120], [0]]);
});

it('无变更时保留当前分页偏移', async () => {
  const load = vi.fn(async () => ['成员']);
  expect(await readFreshGroupMemberPage(120, () => 3, load)).toEqual({
    page: ['成员'],
    offset: 120,
    version: 3,
  });
  expect(load).toHaveBeenCalledOnce();
});

it('连续变更期间不回填失效结果，也不无限补读', async () => {
  let version = 0;
  const load = vi.fn(async () => {
    version++;
    return ['旧成员'];
  });
  expect(await readFreshGroupMemberPage(120, () => version, load)).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

it('历史名片保留，但退群成员不重新混入当前成员名单', () => {
  const members = [
    { uid: 'active', memberFlag: 0 },
    { uid: 'left', memberFlag: 1 },
    { uid: 'unknown' },
  ];
  expect(activeGroupMembers(members).map((member) => member.uid)).toEqual(['active', 'unknown']);
  expect(members).toHaveLength(3);
});
