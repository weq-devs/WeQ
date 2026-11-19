import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import {
  activeGroupMembers,
  createGroupMemberLookup,
  groupMemberPagesOptions,
  refreshGroupMemberPages,
} from '../src/renderer/src/lib/groupMemberRefresh';

it('群资料变化时保留已显示的所有页，后台校准完成后一次更新', async () => {
  const client = new QueryClient();
  const first = Array.from({ length: 120 }, (_, i) => `u_${i}`);
  let release!: (rows: string[]) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let latestFirst = first;
  const load = vi.fn(async (offset: number) => (offset === 0 ? latestFirst : ['u_last']));
  const observer = new InfiniteQueryObserver(client, groupMemberPagesOptions('a', '123', load));
  const stop = observer.subscribe(() => {});
  try {
    await observer.refetch();
    await observer.fetchNextPage();
    const previous = observer.getCurrentResult().data;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          markStarted();
        }),
    );
    const refresh = refreshGroupMemberPages(client, 'a');
    await started;
    expect(observer.getCurrentResult()).toMatchObject({
      isFetching: true,
      isInitialLoading: false,
      isFetchingNextPage: false,
    });
    expect(observer.getCurrentResult().data).toBe(previous);
    latestFirst = ['u_new', ...first.slice(1)];
    release(latestFirst);
    await refresh;
    expect(observer.getCurrentResult().data?.pages).toEqual([
      ['u_new', ...first.slice(1)],
      ['u_last'],
    ]);
    expect(load.mock.calls).toEqual([
      [0, 120],
      [120, 120],
      [0, 120],
      [120, 120],
    ]);
    const updated = observer.getCurrentResult().data;
    await refreshGroupMemberPages(client, 'a');
    expect(observer.getCurrentResult().data).toBe(updated);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    load.mockRejectedValueOnce(new Error('群资料暂不可读'));
    try {
      await refreshGroupMemberPages(client, 'a');
    } finally {
      error.mockRestore();
    }
    expect(observer.getCurrentResult().isRefetchError).toBe(true);
    expect(observer.getCurrentResult().data).toBe(updated);
  } finally {
    stop();
    client.clear();
  }
});

it('变更时作废在途旧分页，不刷新其他账号或未打开的群', async () => {
  const client = new QueryClient();
  const first = Array.from({ length: 120 }, (_, i) => `u_${i}`);
  let release!: (rows: string[]) => void;
  let releaseInactive!: (rows: string[]) => void;
  const load = vi.fn<(offset: number, limit: number) => Promise<string[]>>();
  load
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValueOnce(['u_new']);
  const inactive = vi.fn(async () => ['u_inactive']);
  const inactiveOptions = groupMemberPagesOptions('a', '456', inactive);
  const other = vi.fn(async () => ['u_other']);
  const observer = new InfiniteQueryObserver(client, groupMemberPagesOptions('a', '123', load));
  const otherObserver = new InfiniteQueryObserver(
    client,
    groupMemberPagesOptions('b', '123', other),
  );
  const stop = observer.subscribe(() => {});
  const stopOther = otherObserver.subscribe(() => {});
  try {
    await Promise.all([
      observer.refetch(),
      otherObserver.refetch(),
      client.fetchInfiniteQuery(inactiveOptions),
    ]);
    inactive.mockImplementationOnce(() => new Promise((resolve) => (releaseInactive = resolve)));
    const inactiveFlight = client.prefetchInfiniteQuery({ ...inactiveOptions, staleTime: 0 });
    const next = observer.fetchNextPage();
    await refreshGroupMemberPages(client, 'a');
    release(['u_old']);
    releaseInactive(['u_late']);
    await Promise.all([next, inactiveFlight]);
    expect(observer.getCurrentResult().data?.pages).toEqual([['u_new']]);
    expect(load.mock.calls).toEqual([
      [0, 120],
      [120, 120],
      [0, 120],
    ]);
    expect(other).toHaveBeenCalledOnce();
    expect(inactive).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(inactiveOptions.queryKey)).toMatchObject({
      isInvalidated: true,
      data: { pages: [['u_inactive']] },
    });
  } finally {
    stop();
    stopOther();
    client.clear();
  }
});

it('分页按原始行数推进，整页重复 UID 后还能读到新成员并结束', async () => {
  const client = new QueryClient();
  const load = vi.fn(async (offset: number, limit: number) => {
    if (offset < 2 * limit) return Array.from({ length: limit }, () => 'u_duplicate');
    return ['u_new'];
  });
  const observer = new InfiniteQueryObserver(client, groupMemberPagesOptions('a', '123', load));
  const stop = observer.subscribe(() => {});
  try {
    await observer.refetch();
    await observer.fetchNextPage();
    const result = await observer.fetchNextPage();
    expect(load.mock.calls).toEqual([
      [0, 120],
      [120, 120],
      [240, 120],
    ]);
    expect(result.data?.pages.at(-1)).toEqual(['u_new']);
    expect(result.hasNextPage).toBe(false);
  } finally {
    stop();
    client.clear();
  }
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
