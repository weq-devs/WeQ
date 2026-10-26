import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useGroupMemberSearch,
  type GroupMemberSearch,
} from '../src/renderer/src/hooks/useGroupMemberSearch';
import type { GroupMember } from '../src/renderer/src/im-template/template/types';

const rpc = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchGroupMembers: { query: rpc.search } } },
}));

type Member = GroupMember & { uid: string };
function member(index: number): Member {
  return {
    uid: `u_fixture_${index}`,
    id: `u_fixture_${index}`,
    uin: String(20000 + index),
    identityLabel: 'QQ',
    identityValue: String(20000 + index),
    username: `fixture_${index}`,
    displayName: `合成成员 ${index}`,
    avatarUrl: null,
    role: 'member',
    joinedAt: new Date(0).toISOString(),
  };
}
const mapMember = (row: Member): GroupMember => row;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rpc.search.mockReset();
});

function mount(groupCode: string) {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current: GroupMemberSearch;
  function Probe({ code }: { code: string }) {
    current = useGroupMemberSearch<Member>(code, '合成', mapMember);
    return null;
  }
  const render = (code: string) => act(() => root.render(h(Probe, { code })));
  render(groupCode);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { render, state: () => current };
}

it('联系人切群后，迟到的旧群搜索不能覆盖当前成员', async () => {
  let finishOld!: (value: { members: Member[]; total: number }) => void;
  rpc.search
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ members: [member(2)], total: 1 });
  const probe = mount('10001');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  probe.render('10002');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(probe.state().view.members.map((row) => row.id)).toEqual([member(2).id]);
  await act(async () => {
    finishOld({ members: [member(1)], total: 1 });
  });
  expect(probe.state().view.members.map((row) => row.id)).toEqual([member(2).id]);
  expect(rpc.search.mock.calls.map(([input]) => input.groupCode)).toEqual(['10001', '10002']);
});

it('复用全群搜索分页，不把首屏结果当作全部成员', async () => {
  rpc.search
    .mockResolvedValueOnce({
      members: Array.from({ length: 30 }, (_, index) => member(index)),
      total: 31,
    })
    .mockResolvedValueOnce({ members: [member(30)], total: 31 });
  const probe = mount('10003');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(probe.state().view.hasMore).toBe(true);
  await act(async () => {
    probe.state().loadMore();
  });
  expect(rpc.search).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groupCode: '10003',
      keyword: '合成',
      offset: 30,
    }),
  );
  expect(probe.state().view.members).toHaveLength(31);
  expect(probe.state().view.hasMore).toBe(false);
  act(() => probe.state().loadMore());
  expect(rpc.search).toHaveBeenCalledTimes(2);
});
