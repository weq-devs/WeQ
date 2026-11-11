import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useContactDirectoryOrder } from '../src/renderer/src/hooks/useContactDirectoryOrder';
import { ContactDirectoryOrder } from '../src/renderer/src/components/ContactDirectoryOrder';
import type { DirectoryPreferences } from '../src/renderer/src/lib/contactListOrder';

const state = vi.hoisted(() => ({
  uin: '99999',
  config: { uin: '99999', configId: 'synthetic' } as { uin: string; configId: string } | undefined,
  progress: { status: 'running', done: 2, total: 6, failed: 0, phase: '' },
  timeQuery: vi.fn(),
  profileQuery: vi.fn(),
  joinQuery: vi.fn(),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (value: { openedUin: string }) => unknown) =>
    select({ openedUin: state.uin }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      getAccountConfig: { useQuery: () => ({ data: state.config }) },
      contactMetrics: {
        snapshot: { useQuery: () => ({ data: { rows: {}, progress: state.progress } }) },
        localTimes: {
          useQuery: (...args: unknown[]) => {
            state.timeQuery(...args);
            return { data: undefined };
          },
        },
        cachedProfiles: {
          useQuery: (...args: unknown[]) => {
            state.profileQuery(...args);
            return { data: undefined };
          },
        },
        localJoins: {
          useQuery: (...args: unknown[]) => {
            state.joinQuery(...args);
            return { data: undefined };
          },
        },
        changed: { useSubscription: () => {} },
      },
      qqWrite: { profileRegions: { useQuery: () => ({}) } },
      listAllGroups: { useQuery: () => ({}) },
    },
  },
}));
vi.mock('../src/renderer/src/components/ContactRefreshButton', () => ({
  ContactCacheRefreshDialog: () => null,
}));

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  localStorage.clear();
  state.uin = '99999';
  state.config = { uin: state.uin, configId: 'synthetic' };
  state.progress.status = 'running';
  state.timeQuery.mockClear();
  state.profileQuery.mockClear();
  state.joinQuery.mockClear();
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function save(kind: 'friends' | 'groups', value: DirectoryPreferences, configId = 'synthetic') {
  localStorage.setItem(
    `weq.contacts.order.${configId}.${state.uin}.${kind}`,
    JSON.stringify(value),
  );
}
function mount(kind: 'friends' | 'groups', entities: string[][] = [], freeze = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const commits: DirectoryPreferences[] = [];
  let order!: ReturnType<typeof useContactDirectoryOrder>;
  function Harness({ kind }: { kind: 'friends' | 'groups' }) {
    order = useContactDirectoryOrder(kind, freeze, entities);
    useLayoutEffect(() => {
      commits.push(order.preferences);
    });
    return createElement(ContactDirectoryOrder, { order });
  }
  const render = (kind: 'friends' | 'groups', key = kind) =>
    act(() => root.render(createElement(Harness, { kind, key })));
  render(kind);
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    commits,
    render,
    change: (patch: Partial<DirectoryPreferences>) => act(() => order.change(patch)),
    order: () => order,
  };
}

it('新增读取只在所选依据启用，画像仅请求批量缓存摘要，多选不启动时间续读', () => {
  const f = mount('friends');
  expect(state.timeQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  expect(state.profileQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  f.change({ sort: 'lastMessageAt' });
  expect(state.timeQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  expect(state.profileQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  f.change({ sort: 'affinity' });
  expect(state.timeQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  expect(state.profileQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  save('groups', { grouping: 'none', sort: 'lastSpokeAt', descending: true });
  mount('groups', [], true);
  expect(state.timeQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
});

it.each(['running', 'paused'])(
  '任务 %s 时切换缺失缓存的分组与排序只更新偏好，不请求弹窗',
  (status) => {
    state.progress.status = status;
    const f = mount('friends', [['friend:missing']]);
    f.change({ grouping: 'direction' });
    expect(f.order().preferences.grouping).toBe('direction');
    expect(f.order().refreshRequest).toBeNull();
    f.change({ sort: 'level' });
    expect(f.order().preferences.sort).toBe('level');
    expect(f.order().refreshRequest).toBeNull();
  },
);

it('没有在途任务时切换缺失缓存的依据仍询问更新', () => {
  state.progress.status = 'completed';
  const f = mount('friends', [['friend:missing']]);
  f.change({ sort: 'level' });
  expect(f.order().refreshRequest?.fields).toEqual(['level']);
});

it('好友与群聊首次挂载及反复切换时，每次提交都直接使用各自保存的分组、排序和方向', () => {
  const friends = { grouping: 'birthYear', sort: 'age', descending: true };
  const groups = { grouping: 'capacity', sort: 'memberCount', descending: false };
  save('friends', friends);
  save('groups', groups);
  const f = mount('friends');
  expect(f.commits).toEqual([friends]);
  f.commits.length = 0;
  f.render('groups');
  expect(f.commits).toEqual([groups]);
  f.commits.length = 0;
  f.render('friends');
  expect(f.commits).toEqual([friends]);
  f.change({ descending: false });
  f.render('groups');
  f.commits.length = 0;
  f.render('friends');
  expect(f.commits).toEqual([{ ...friends, descending: false }]);
});

it('账号配置延迟就绪或切换配置时，不提交默认值或其他配置的偏好', () => {
  const first = { grouping: 'birthYear', sort: 'age', descending: true };
  const second = { grouping: 'none', sort: 'remark', descending: false };
  save('friends', first);
  save('friends', second, 'other');
  state.config = undefined;
  const f = mount('friends');
  f.commits.length = 0;
  state.config = { uin: state.uin, configId: 'synthetic' };
  f.render('friends');
  expect(f.commits).toEqual([first]);
  f.commits.length = 0;
  state.config = { uin: state.uin, configId: 'other' };
  f.render('friends');
  expect(f.commits).toEqual([second]);
});

it.each(['friends', 'groups'] as const)(
  '%s 默认依据也显示更新进度与暂停提示，完成后隐藏',
  (kind) => {
    const f = mount(kind);
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('好友/群信息缓存更新中 2/6');
    state.progress.status = 'paused';
    f.render(kind);
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain('更新已暂停');
    state.progress.status = 'completed';
    f.render(kind);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  },
);

it.each(['not-json', '{"grouping":"invalid","sort":"remark","descending":false}'])(
  '损坏或不适用的偏好回退默认值：%s',
  (value) => {
    localStorage.setItem(`weq.contacts.order.synthetic.${state.uin}.friends`, value);
    const f = mount('friends');
    expect(f.commits.every((value) => value.grouping === 'qq' && value.sort === 'remark')).toBe(
      true,
    );
  },
);
