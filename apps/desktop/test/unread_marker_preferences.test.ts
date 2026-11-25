import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReminderCount } from '../src/renderer/src/components/ReminderBadge';
import { useWorkspaceSettingsBadge } from '../src/renderer/src/hooks/useWorkspaceEntryBadges';
import { WorkspaceMenuButton } from '../src/renderer/src/components/WorkspaceMenuButton';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { useUpdateStore } from '../src/renderer/src/state/update';
vi.mock('../src/renderer/src/components/lazyWorkspaces', () => ({ preloadWorkspace: () => {} }));
vi.mock('../src/renderer/src/components/lazyWorkspaces.shared', () => ({
  preloadWorkspace: () => {},
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  acceptPreferences({ epoch: String(Math.random()), revision: 0, values: {}, records: {} }, false);
  useUpdateStore.setState({ softwareAvailable: false, packsAvailable: false });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(node: ReturnType<typeof h>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('旧的基础未读显示偏好不再隐藏普通未读数字', () => {
  const host = mount(h(ReminderCount, { count: 8 }));
  expect(host.textContent).toBe('8');
  const legacyValues = {
    showMailItemUnreadBadge: false,
    showAssistantUnreadBadge: false,
    showConversationUnreadBadge: false,
    showUpdateBadge: true,
  };
  act(() => acceptPreferences({ revision: 1, values: legacyValues, records: {} }, false));
  expect(host.textContent).toBe('8');
});
it('任务进行中标记跨端更新后可独立隐藏和恢复，不改计数', () => {
  const host = mount(h(ReminderCount, { count: 3, marker: 'running' }));
  act(() =>
    acceptPreferences({ revision: 1, values: { showTaskRunningBadge: false }, records: {} }, false),
  );
  expect(host.textContent).toBe('');
  act(() =>
    acceptPreferences(
      {
        revision: 2,
        values: { showTaskRunningBadge: true },
        records: {},
      },
      false,
    ),
  );
  expect(host.textContent).toBe('3');
});
it('菜单汇总任务；关闭角标不清空对应状态', () => {
  useWorkspaceMenu.setState({
    running: 0,
    finished: 2,
    unreadFailed: 1,
  });
  useUpdateStore.setState({ packsAvailable: true });
  const host = mount(h(WorkspaceMenuButton));
  expect(host.querySelector('.weq-reminder-dot')).not.toBeNull();
  act(() =>
    acceptPreferences(
      {
        revision: 1,
        values: {
          showTaskResultBadge: false,
          showUpdateBadge: false,
          showTaskRunningBadge: false,
        },
        records: {},
      },
      false,
    ),
  );
  expect(host.querySelector('.weq-workspace-dot')).toBeNull();
  expect(useWorkspaceMenu.getState().finished).toBe(2);
  expect(useWorkspaceMenu.getState().unreadFailed).toBe(1);
  expect(useUpdateStore.getState().packsAvailable).toBe(true);
  act(() => useWorkspaceMenu.setState({ running: 1 }));
  expect(host.querySelector('.weq-reminder-count')).toBeNull();
  expect(useWorkspaceMenu.getState().running).toBe(1);
  act(() =>
    acceptPreferences(
      {
        revision: 2,
        values: {
          showTaskRunningBadge: true,
          showTaskResultBadge: false,
          showUpdateBadge: false,
        },
        records: {},
      },
      false,
    ),
  );
  expect(host.querySelector('.weq-reminder-count')?.textContent).toBe('1');
});

it('设置入口分别遵循软件更新和增强包更新的角标开关', () => {
  function SettingsBadge() {
    return useWorkspaceSettingsBadge()?.description ?? null;
  }
  const host = mount(h(SettingsBadge));
  const label = () => host.textContent;
  expect(label()).toBe('');

  act(() => useUpdateStore.getState().setSoftwareAvailable(true));
  expect(label()).toBe('有软件更新');
  act(() => useUpdateStore.getState().setPacksAvailable(true));
  expect(label()).toBe('有软件更新和增强包更新');
  act(() =>
    acceptPreferences({ revision: 1, values: { showUpdateBadge: false }, records: {} }, false),
  );
  expect(label()).toBe('有软件更新');
  act(() =>
    acceptPreferences(
      { revision: 2, values: { showSoftwareUpdateBadge: false }, records: {} },
      false,
    ),
  );
  expect(label()).toBe('有增强包更新');
  expect(useUpdateStore.getState().softwareAvailable).toBe(true);
});
