import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import {
  ContactRefreshButton,
  ContactCacheRefreshDialog,
} from '../src/renderer/src/components/ContactRefreshButton';
import { useGroupMemberRefresh } from '../src/renderer/src/hooks/useGroupMemberRefresh';

const state = vi.hoisted(() => ({
  uin: '99999',
  config: { uin: '99999', configId: 'fixture' },
  snapshot: { taskId: 'existing', target: 'metrics', progress: { status: 'running' } },
  confirm: vi.fn(async () => false),
  focusTask: vi.fn(),
  openTasks: vi.fn(),
  rebuild: vi.fn(async () => 'new-task'),
  showError: vi.fn(),
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
  Modal: ({ children, labelledBy }: { children: ReactNode; labelledBy: string }) =>
    h('div', { role: 'dialog', 'aria-labelledby': labelledBy }, children),
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
        if (!group) {
          expect(host.querySelector('button')?.title).toBe('查看好友/群信息缓存更新任务');
          expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
            '查看好友/群信息缓存更新任务',
          );
        }
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
    expect(contacts.host.querySelector('button')?.title).toBe('更新好友/群信息缓存');
    expect(contacts.host.querySelector('button')?.getAttribute('aria-label')).toBe(
      '更新好友/群信息缓存',
    );
    await act(async () => contacts.host.querySelector('button')!.click());
    expect(contacts.host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(contacts.host.querySelector('h3')?.textContent?.trim()).toBe('更新好友/群信息缓存');
    const members = mount(true);
    await act(async () => members.host.querySelector('button')!.click());
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.focusTask).not.toHaveBeenCalled();
  },
);
it.each([false, true])('主动与过期更新弹窗统一名称、范围和操作文案：%s', async (stale) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  cleanup.push(() => act(() => root.unmount()));
  const onClose = vi.fn();
  act(() => root.render(h(ContactCacheRefreshDialog, { onClose, stale })));
  expect(host.querySelector('h3')?.textContent?.trim()).toBe('更新好友/群信息缓存');
  expect(host.textContent).toContain('选择好友/群信息缓存的更新范围。');
  expect(host.querySelector('[aria-label="好友/群信息缓存更新范围"]')).not.toBeNull();
  expect(host.querySelector('.weq-action-primary')?.textContent).toBe('更新');
  expect(host.textContent).not.toContain('信息与线索缓存');
  if (stale) expect(host.textContent).toContain('所选依据的好友/群信息缓存');
  state.rebuild.mockRejectedValueOnce(new Error('合成错误'));
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-action-primary')!.click());
  expect(state.showError).toHaveBeenCalledWith('好友/群信息缓存更新启动失败', '合成错误');
});
it('账号配置尚未匹配时不跳到旧账号的任务', async () => {
  state.uin = '88888';
  const { host } = mount(false);
  await act(async () => host.querySelector('button')!.click());
  expect(state.focusTask).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
