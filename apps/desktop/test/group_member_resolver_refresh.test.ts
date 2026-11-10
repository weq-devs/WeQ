import { act, createElement as h, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useGroupMemberResolver,
  GROUP_MEMBER_PREVIEW_REFRESH_MS,
  type GroupMemberResolver,
} from '../src/renderer/src/hooks/useGroupMemberResolver';

type Member = { uid: string; card: string };
const mock = vi.hoisted(() => ({
  query: vi.fn<(input: { groupCode: string; uids: string[] }) => Promise<Member[]>>(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getGroupMembersByUids: { query: mock.query } } },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('跨群补全串行执行，群资料连续失效也不叠加在途查询', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const finishes: Array<(members: Member[]) => void> = [];
  mock.query.mockReset().mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  act(() => {
    for (let revision = 0; revision < 20; revision++) {
      resolver.invalidate();
      for (let group = 0; group < 100; group++)
        resolver.resolveMembers(String(group), ['u_peer'], new Set(), () => true);
    }
  });
  expect(mock.query).toHaveBeenCalledTimes(1);
  await act(async () => finishes[0]([]));
  expect(mock.query).toHaveBeenCalledTimes(2);
  await act(async () => finishes[1]([{ uid: 'u_peer', card: '最新资料' }]));
  expect(resolver.missingMembers['0'].u_peer.card).toBe('最新资料');
  expect(mock.query).toHaveBeenCalledTimes(3);
  for (let index = 2; index < 101; index++) await act(async () => finishes[index]([]));
  expect(mock.query).toHaveBeenCalledTimes(101);
});

it('卸载后不再启动排队的其他群补全', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (members: Member[]) => void;
  mock.query.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  act(() => {
    resolver.resolveMembers('123', ['u_peer'], new Set(), () => true);
    resolver.resolveMembers('456', ['u_peer'], new Set(), () => true);
    root.unmount();
  });
  await act(async () => finish([]));
  expect(mock.query).toHaveBeenCalledTimes(1);
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
  let current = true;
  await act(async () => {
    resolver.resolveMembers('123', ['u_peer'], new Set(), () => current);
    current = false;
  });
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(resolver.missingMembers['123'].u_peer.card).toBe('群名片');
});

it('预览缓存失效合并到刷新间隔，新发言人不等旧缓存冷却，末次通知不会丢失', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_peer', card: '旧名片' }]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>(GROUP_MEMBER_PREVIEW_REFRESH_MS);
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => resolver.resolveMembers('123', ['u_peer'], new Set(), () => true));
  mock.query.mockResolvedValue([{ uid: 'u_new', card: '新发言人' }]);
  await act(async () => {
    for (let revision = 0; revision < 20; revision++) {
      resolver.invalidate();
      resolver.resolveMembers('123', ['u_peer', 'u_new'], new Set(), () => true);
    }
  });
  // 冷却只限制已查询的成员，不延迟新发言人。
  expect(mock.query).toHaveBeenCalledTimes(3);
  expect(resolver.missingMembers['123'].u_new.card).toBe('新发言人');
  mock.query.mockResolvedValue([
    { uid: 'u_peer', card: '新名片' },
    { uid: 'u_new', card: '新发言人' },
  ]);
  await act(async () => vi.advanceTimersByTimeAsync(GROUP_MEMBER_PREVIEW_REFRESH_MS - 1));
  expect(mock.query).toHaveBeenCalledTimes(3);
  expect(resolver.missingMembers['123'].u_peer.card).toBe('旧名片');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(mock.query).toHaveBeenCalledTimes(4);
  expect(resolver.missingMembers['123'].u_peer.card).toBe('新名片');
  expect(resolver.missingMembers['123'].u_new.card).toBe('新发言人');
});

it('开发模式双挂载丢弃首次在途结果后仍立即补全，不进入预览冷却', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_peer', card: '群名片' }]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>(GROUP_MEMBER_PREVIEW_REFRESH_MS);
    const { resolveMembers } = resolver;
    useEffect(() => resolveMembers('123', ['u_peer'], new Set(), () => true), [resolveMembers]);
    return null;
  }
  await act(async () => root.render(h(StrictMode, null, h(Probe))));
  cleanups.push(() => act(() => root.unmount()));
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(resolver.missingMembers['123'].u_peer.card).toBe('群名片');
  expect(vi.getTimerCount()).toBe(0);
});

it('跨群排队跳过已切走会话，单群仍按接口上限分批并对空结果去重', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.query.mockReset().mockResolvedValue([]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  const uids = Array.from({ length: 401 }, (_, i) => `u_${i}`);
  let current = true;
  await act(async () => {
    resolver.resolveMembers('123', uids, new Set(), () => true);
    resolver.resolveMembers('456', ['u_old'], new Set(), () => current);
    current = false;
  });
  expect(mock.query.mock.calls.map((args) => args[0])).toEqual([
    { groupCode: '123', uids: uids.slice(0, 200) },
    { groupCode: '123', uids: uids.slice(200, 400) },
    { groupCode: '123', uids: uids.slice(400) },
  ]);
  await act(async () => resolver.resolveMembers('123', uids, new Set(), () => true));
  expect(mock.query).toHaveBeenCalledTimes(3);
});

it('百群列表在持续通知期间不重复扫库，冷却结束仅补最后一轮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mock.query.mockReset().mockResolvedValue([]);
  let resolver!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    resolver = useGroupMemberResolver<Member>(GROUP_MEMBER_PREVIEW_REFRESH_MS);
    return null;
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  const resolveAll = () => {
    for (let group = 0; group < 100; group++)
      resolver.resolveMembers(String(group), ['u_peer'], new Set(), () => true);
  };
  await act(async () => resolveAll());
  expect(mock.query).toHaveBeenCalledTimes(100);
  for (let revision = 0; revision < 20; revision++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      resolver.invalidate();
      resolveAll();
    });
  }
  expect(mock.query).toHaveBeenCalledTimes(100);
  await act(async () => vi.advanceTimersByTimeAsync(GROUP_MEMBER_PREVIEW_REFRESH_MS - 2000));
  expect(mock.query).toHaveBeenCalledTimes(200);
  expect(vi.getTimerCount()).toBe(0);
});

it('当前聊天不等待列表预览冷却，卸载取消预览的尾部刷新', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_peer', card: '群名片' }]);
  let preview!: GroupMemberResolver<Member>;
  let chat!: GroupMemberResolver<Member>;
  const root = createRoot(document.createElement('div'));
  function Probe() {
    preview = useGroupMemberResolver<Member>(GROUP_MEMBER_PREVIEW_REFRESH_MS);
    chat = useGroupMemberResolver<Member>();
    return null;
  }
  act(() => root.render(h(Probe)));
  await act(async () => {
    preview.resolveMembers('123', ['u_peer'], new Set(), () => true);
    chat.resolveMembers('123', ['u_peer'], new Set(), () => true);
  });
  await act(async () => {
    preview.invalidate();
    chat.invalidate();
    preview.resolveMembers('123', ['u_peer'], new Set(), () => true);
    chat.resolveMembers('123', ['u_peer'], new Set(), () => true);
  });
  expect(mock.query).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(1);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(GROUP_MEMBER_PREVIEW_REFRESH_MS));
  expect(mock.query).toHaveBeenCalledTimes(3);
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
