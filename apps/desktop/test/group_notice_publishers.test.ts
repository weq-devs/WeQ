import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGroupNoticePublishers } from '../src/renderer/src/hooks/useGroupNoticePublishers';
import type { GroupNoticeEntry } from '../src/renderer/src/lib/groupNotices';

const rpc = vi.hoisted(() => ({
  source: 'source-a',
  byUid: vi.fn(),
  byUin: vi.fn(),
  profiles: vi.fn(),
  profileByUin: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useGroupProfile', () => ({
  useGroupReadScope: () => ({
    active: true,
    key: rpc.source,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: rpc.source },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getGroupMembersByUids: { query: rpc.byUid },
      getGroupMembersByUins: { query: rpc.byUin },
      getProfilesByUids: { query: rpc.profiles },
      getProfileByUin: { query: rpc.profileByUin },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  rpc.source = 'source-a';
  rpc.byUid.mockResolvedValue([]);
  rpc.byUin.mockResolvedValue([]);
  rpc.profiles.mockResolvedValue([]);
  rpc.profileByUin.mockResolvedValue(null);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function entry(identity: string): GroupNoticeEntry {
  return { key: identity, publisherUid: identity, text: '公告', date: '', images: [] };
}
function fixture(entries: GroupNoticeEntry[]) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const client = new QueryClient({
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  let rows: GroupNoticeEntry[] = [];
  function Probe({ groupCode }: { groupCode: string }) {
    rows = useGroupNoticePublishers(groupCode, entries);
    return h('output', null, rows.map((row) => row.publisherName || row.publisherUid).join(','));
  }
  function render(groupCode = '123456') {
    act(() => root.render(h(QueryClientProvider, { client }, h(Probe, { groupCode }))));
  }
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    client.clear();
  });
  return { host, render, rows: () => rows };
}
async function settled(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertion();
  });
}
it('未加载群成员分页也按公告引用批量补全，去重并传递来源', async () => {
  rpc.byUid.mockResolvedValue([{ uid: 'u_peer', uin: '10002', card: '合成群名片', nick: '昵称' }]);
  const f = fixture([entry('u_peer'), { ...entry('u_peer'), key: 'another' }, entry('10003')]);
  await settled(() => expect(f.host.textContent).toBe('合成群名片,合成群名片,10003'));
  expect(rpc.byUid).toHaveBeenCalledTimes(1);
  expect(rpc.byUid).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    groupCode: '123456',
    uids: ['u_peer'],
  });
  expect(rpc.byUin).toHaveBeenCalledWith(expect.objectContaining({ uins: ['10003'] }));
  expect(f.rows()[0]!.publisherAvatar).toContain('nk=10002');
  expect(f.rows()[2]!.publisherAvatar).toContain('nk=10003');
});
it('本地已退群个人资料仍可补全名称头像，不需要 QQ 在线', async () => {
  rpc.profiles.mockResolvedValue([
    { uid: 'u_left', uin: '10004', nick: '已退群昵称', remark: '', avatarUrl: '' },
  ]);
  const f = fixture([entry('u_left')]);
  await settled(() => expect(f.host.textContent).toBe('已退群昵称'));
  expect(f.rows()[0]!.publisherAvatar).toContain('nk=10004');
});
it('相同 QQ 号切换数据源后，迟到的旧来源补全不覆盖新来源', async () => {
  let finish!: (value: unknown[]) => void;
  rpc.profiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture([entry('u_peer')]);
  rpc.source = 'source-b';
  rpc.profiles.mockResolvedValue([
    { uid: 'u_peer', uin: '10005', nick: '新来源昵称', remark: '', avatarUrl: '' },
  ]);
  f.render();
  await settled(() => expect(f.host.textContent).toBe('新来源昵称'));
  await act(async () =>
    finish([{ uid: 'u_peer', uin: '10006', nick: '旧来源昵称', remark: '', avatarUrl: '' }]),
  );
  expect(f.host.textContent).toBe('新来源昵称');
});
it('超过批量上限时按 200 人分块，不扫描整群', async () => {
  fixture(Array.from({ length: 201 }, (_, index) => entry(`u_peer${index}`)));
  await settled(() => expect(rpc.profiles).toHaveBeenCalledTimes(2));
  expect(rpc.byUid.mock.calls.map(([input]) => input.uids.length)).toEqual([200, 1]);
});
