import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ContactRefreshButton } from '../src/renderer/src/components/ContactRefreshButton';
import { useGroupMemberRefresh } from '../src/renderer/src/hooks/useGroupMemberRefresh';

const state = vi.hoisted(() => ({
  uin: '99999',
  config: { uin: '99999', configId: 'fixture' },
  snapshot: { taskId: 'existing', target: 'metrics', progress: { status: 'running' } },
  confirm: vi.fn(async () => false),
  focusTask: vi.fn(),
  openTasks: vi.fn(),
  rebuild: vi.fn(async () => 'new-task'),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign(
    (select: (value: { openedUin: string }) => unknown) => select({ openedUin: state.uin }),
    { getState: () => ({ openedUin: state.uin }) },
  ),
}));
vi.mock('../src/renderer/src/state/workspaceMenu', () => ({
  useWorkspaceMenu: { getState: () => state },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (value: typeof state) => unknown) => select(state),
  Modal: () => h('div', { role: 'dialog' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        contactMetrics: { status: { invalidate: vi.fn() } },
        getRelationGraph: { invalidate: vi.fn() },
      },
    }),
    account: {
      getAccountConfig: { useQuery: () => ({ data: state.config }) },
      contactMetrics: {
        status: { useQuery: () => ({ data: state.snapshot }) },
        changed: { useSubscription: () => {} },
        rebuild: { useMutation: () => ({ mutateAsync: state.rebuild, isLoading: false }) },
      },
    },
  },
}));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  state.uin = '99999';
  state.snapshot.progress.status = 'running';
  vi.clearAllMocks();
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});
function GroupRefresh() {
  const { refresh, refreshing, ready } = useGroupMemberRefresh();
  return h('button', { onClick: refresh, disabled: !ready, 'aria-busy': refreshing }, '更新成员');
}
function mount(group: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onRefresh = vi.fn();
  const render = () =>
    act(() => root.render(group ? h(GroupRefresh) : h(ContactRefreshButton, { onRefresh })));
  render();
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, render, onRefresh };
}
it.each(['metrics', 'groupMembers'])(
  '%s 任务运行或暂停时，两个手动入口均直接聚焦原任务',
  async (target) => {
    state.snapshot.target = target;
    for (const status of ['running', 'paused']) {
      state.snapshot.progress.status = status;
      for (const group of [false, true]) {
        const { host, onRefresh } = mount(group);
        await act(async () => host.querySelector('button')!.click());
        expect(state.focusTask).toHaveBeenLastCalledWith('background:host:existing');
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(state.confirm).not.toHaveBeenCalled();
        expect(state.rebuild).not.toHaveBeenCalled();
        expect(onRefresh).not.toHaveBeenCalled();
      }
    }
    expect(state.focusTask).toHaveBeenCalledTimes(4);
  },
);
it.each(['completed', 'failed', 'cancelled', 'idle'])(
  '任务 %s 后手动触发仍走原确认流程',
  async (status) => {
    state.snapshot.progress.status = status;
    const contacts = mount(false);
    await act(async () => contacts.host.querySelector('button')!.click());
    expect(contacts.host.querySelector('[role="dialog"]')).not.toBeNull();
    const members = mount(true);
    await act(async () => members.host.querySelector('button')!.click());
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.focusTask).not.toHaveBeenCalled();
  },
);
it('账号配置尚未匹配时不跳到旧账号的任务', async () => {
  state.uin = '88888';
  const { host } = mount(false);
  await act(async () => host.querySelector('button')!.click());
  expect(state.focusTask).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
