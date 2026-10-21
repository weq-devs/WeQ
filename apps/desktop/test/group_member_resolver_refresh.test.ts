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
