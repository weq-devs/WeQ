import { expect, it, vi } from 'vitest';
import {
  readFreshGroupMemberPage,
  activeGroupMembers,
  createGroupMemberLookup,
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

it('聊天与列表重叠补全时共享在途成员，不跨群合并，也不重复提交 UID', async () => {
  type Member = { uid: string; card: string };
  const finishes: Array<(members: Member[]) => void> = [];
  const read = vi.fn(
    (_input: { groupCode: string; uids: string[] }) =>
      new Promise<Member[]>((resolve) => finishes.push(resolve)),
  );
  const lookup = createGroupMemberLookup(read);
  const chat = lookup.load({ groupCode: '123', uids: ['u_a', 'u_b', 'u_a'] });
  const preview = lookup.load({ groupCode: '123', uids: ['u_b', 'u_c'] });
  const other = lookup.load({ groupCode: '456', uids: ['u_b'] });
  await Promise.resolve();
  expect(read.mock.calls.map(([input]) => input)).toEqual([
    { groupCode: '123', uids: ['u_a', 'u_b'] },
    { groupCode: '123', uids: ['u_c'] },
    { groupCode: '456', uids: ['u_b'] },
  ]);
  finishes[0]([{ uid: 'u_b', card: '甲群' }]);
  finishes[1]([{ uid: 'u_c', card: '新成员' }]);
  finishes[2]([{ uid: 'u_b', card: '乙群' }]);
  const [chatRows, previewRows, otherRows] = await Promise.all([chat, preview, other]);
  expect(chatRows).toEqual([{ uid: 'u_b', card: '甲群' }]);
  expect(previewRows).toEqual([
    { uid: 'u_b', card: '甲群' },
    { uid: 'u_c', card: '新成员' },
  ]);
  expect(previewRows[0]).toBe(chatRows[0]);
  expect(otherRows).toEqual([{ uid: 'u_b', card: '乙群' }]);
});

it('资料失效后的新查询不复用旧在途结果，旧请求结束也不清除新请求', async () => {
  type Member = { uid: string; card: string };
  const finishes: Array<(members: Member[]) => void> = [];
  const read = vi.fn(() => new Promise<Member[]>((resolve) => finishes.push(resolve)));
  const lookup = createGroupMemberLookup(read);
  const input = { groupCode: '123', uids: ['u_a'] };
  const old = lookup.load(input);
  await Promise.resolve();
  lookup.invalidate();
  const fresh = lookup.load(input);
  await Promise.resolve();
  finishes[0]([{ uid: 'u_a', card: '旧名片' }]);
  await old;
  const shared = lookup.load(input);
  expect(read).toHaveBeenCalledTimes(2);
  finishes[1]([{ uid: 'u_a', card: '新名片' }]);
  expect(await fresh).toEqual([{ uid: 'u_a', card: '新名片' }]);
  expect(await shared).toEqual([{ uid: 'u_a', card: '新名片' }]);
  const next = lookup.load(input);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(3);
  finishes[2]([]);
  expect(await next).toEqual([]);
});

it('失败后的在途记录会释放，独立账号实例不共享查询，空批次不读取', async () => {
  const read = vi
    .fn<() => Promise<Array<{ uid: string }>>>()
    .mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValue([]);
  const lookup = createGroupMemberLookup(read);
  const otherAccount = createGroupMemberLookup(read);
  const input = { groupCode: '123', uids: ['u_a'] };
  expect(await lookup.load({ ...input, uids: [] })).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  const first = lookup.load(input);
  const shared = lookup.load(input);
  await expect(first).rejects.toThrow('读取失败');
  await expect(shared).rejects.toThrow('读取失败');
  await Promise.all([lookup.load(input), otherAccount.load(input)]);
  expect(read).toHaveBeenCalledTimes(3);
});
