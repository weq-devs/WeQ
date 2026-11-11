import { act, createElement as h } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryRoot } from './support/query_root';
import { useContactProfile } from '../src/renderer/src/hooks/useContactCard';
const state = vi.hoisted(() => ({ config: 'source-a', query: vi.fn(), byUin: vi.fn() }));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.config },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {},
  client: {
    account: { getProfile: { query: state.query }, getProfileByUin: { query: state.byUin } },
  },
}));
const cleanups: Array<() => void> = [];
it('QQ 号补出 UID 后进入资料页复用同一结果，不重复查 UID', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.config = 'source-a';
  state.query.mockReset();
  state.byUin
    .mockReset()
    .mockResolvedValue({ uid: 'u_resolved', uin: '10002', nick: '补全后的昵称' });
  const host = document.createElement('div');
  const root = createQueryRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  function Probe({ uid = '' }: { uid?: string }) {
    const { profile } = useContactProfile({
      id: uid,
      uid,
      identityLabel: 'QQ',
      identityValue: '10002',
      username: '10002',
      displayName: '本地昵称',
      nick: '本地昵称',
      avatarUrl: null,
    });
    return h('span', null, profile.nick);
  }
  await act(async () => root.render(h(Probe)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.textContent).toBe('补全后的昵称');
  act(() => root.render(h(Probe, { uid: 'u_resolved' })));
  expect(host.textContent).toBe('补全后的昵称');
  expect(state.byUin).toHaveBeenCalledOnce();
  expect(state.query).not.toHaveBeenCalled();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
it('同号换来源隔离在途结果，重进复用相同来源的共享缓存', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const finishes: Array<(value: unknown) => void> = [];
  state.query
    .mockReset()
    .mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  state.config = 'source-a';
  const host = document.createElement('div');
  const root = createQueryRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  function Probe() {
    const { profile } = useContactProfile({
      id: 'u_peer',
      uid: 'u_peer',
      identityLabel: 'QQ',
      identityValue: '10002',
      username: 'u_peer',
      displayName: '本地昵称',
      nick: '本地昵称',
      avatarUrl: null,
    });
    return h('span', null, profile.nick);
  }
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  act(() => root.render(h(Probe)));
  expect(host.textContent).toBe('本地昵称');
  expect(state.query.mock.calls[0]?.[0]).toMatchObject({ expectedAccountConfigId: 'source-a' });
  state.config = 'source-b';
  act(() => root.render(h(Probe)));
  expect(state.query).toHaveBeenCalledTimes(2);
  await act(async () => {
    finishes[1]!({ uid: 'u_peer', uin: '10002', nick: '来源乙' });
    await flush();
  });
  expect(host.textContent).toBe('来源乙');
  await act(async () => {
    finishes[0]!({ uid: 'u_peer', uin: '10002', nick: '来源甲迟到' });
    await flush();
  });
  expect(host.textContent).toBe('来源乙');
  act(() => root.render(h('span', null, '关闭名片')));
  act(() => root.render(h(Probe)));
  expect(host.textContent).toBe('来源乙');
  expect(state.query).toHaveBeenCalledTimes(2);
});
