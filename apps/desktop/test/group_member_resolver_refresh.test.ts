import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useGroupMemberResolver,
  type GroupMemberResolver,
} from '../src/renderer/src/hooks/useGroupMemberResolver';

type Member = { uid: string; card: string };
const mock = vi.hoisted(() => ({ query: vi.fn<() => Promise<Member[]>>() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getGroupMembersByUids: { query: mock.query } } },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('群资料失效时保留展示资料，阻止迟到补全并允许重查', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (members: Member[]) => void;
  mock.query
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce([{ uid: 'u_peer', card: '新成员' }]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  act(() => {
    resolver.updateMembers('123', [{ uid: 'u_left', card: '已退群' }]);
    resolver.resolveMembers('123', ['u_peer'], new Set(), () => true);
    resolver.invalidate();
  });
  await act(async () => finish([{ uid: 'u_peer', card: '旧成员' }]));
  expect(resolver.missingMembers).toEqual({
    '123': { u_left: { uid: 'u_left', card: '已退群' } },
  });
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  expect(resolver.missingMembers['123'].u_peer.card).toBe('新成员');
});
it('切走时丢弃的查询允许切回后重试', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_peer', card: '群名片' }]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => false));
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(resolver.missingMembers['123'].u_peer.card).toBe('群名片');
});
it('刷新等待及查询失败期间不退回空资料，成功后允许清空旧名片', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (members: Member[]) => void;
  mock.query
    .mockReset()
    .mockRejectedValueOnce(new Error('暂时读取失败'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let resolver!: GroupMemberResolver<Member>;
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return h('output', null, resolver.missingMembers['123']?.u_peer?.card ?? 'QQ号');
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => {
    act(() => root.unmount());
    error.mockRestore();
  });
  act(() => {
    resolver.updateMembers('123', [{ uid: 'u_peer', card: '旧名片' }]);
    resolver.invalidate();
  });
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  expect(host.textContent).toBe('旧名片');
  act(() => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  expect(host.textContent).toBe('旧名片');
  await act(async () => finish([{ uid: 'u_peer', card: '' }]));
  expect(host.textContent).toBe('');
});
it('名片读回定向更新群缓存，迟到补全不能覆盖新值，也不影响其他群', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (members: Member[]) => void;
  mock.query.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let resolver!: GroupMemberResolver<Member>;
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return h('output', null, resolver.missingMembers['123']?.u_peer?.card);
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  act(() => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  act(() => {
    resolver.updateMembers('456', [{ uid: 'u_peer', card: '另一群' }]);
    resolver.updateMembers('123', [{ uid: 'u_peer', card: '新名片' }]);
  });
  await act(async () => finish([{ uid: 'u_peer', card: '迟到的旧名片' }]));
  expect(host.textContent).toBe('新名片');
  expect(resolver.missingMembers['456'].u_peer.card).toBe('另一群');
});
