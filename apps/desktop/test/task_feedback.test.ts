import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import { useTaskNotifications } from '../src/renderer/src/hooks/useTaskNotifications';
import { TaskNotificationTracker } from '../src/renderer/src/lib/taskNotificationState';
import { taskNotificationKey } from '../src/renderer/src/lib/taskNotificationPresentation';
import { notifyTaskCreated } from '../src/renderer/src/lib/taskNotifications';
import { notificationSource } from '../src/renderer/src/lib/notificationNavigation.shared';
import type { WorkspaceTaskIndicator } from '../src/renderer/src/lib/workspaceIndicators';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';

const rpc = vi.hoisted(() => ({ notify: vi.fn(async () => true) }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { bootstrap: { notifyConfiguredEvent: { mutate: rpc.notify } } },
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  accountBinding: () => ({ expectedAccountUin: 'fixture', expectedAccountConfigId: 'source' }),
  preferenceValue: () => false,
}));
const scope = JSON.stringify(['fixture', 'source']);
const task = (patch: Partial<WorkspaceTaskIndicator> = {}): WorkspaceTaskIndicator => ({
  id: 'export:save',
  name: '合成保存',
  activity: 'running',
  result: 'v1',
  failed: false,
  autoOpenTaskList: false,
  ...patch,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let focused: ReturnType<typeof vi.spyOn>;
function Harness({ items, open }: { items: WorkspaceTaskIndicator[]; open: boolean }) {
  useTaskNotifications(scope, items, true, open);
  return h(ToastHost);
}
function render(items: WorkspaceTaskIndicator[], open = false) {
  act(() => root.render(h(Harness, { items, open })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  rpc.notify.mockClear();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useWorkspaceMenu.setState({ taskScope: scope, taskPanelScope: null, taskItems: [] });
  useNotificationPolicy
    .getState()
    .setEvents(normalizeNotificationEvents({ taskComplete: { system: true } }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('自动开列表的新任务不先弹进度或成功，失败仍提醒', () => {
  const tracker = new TaskNotificationTracker();
  tracker.update(scope, [], true);
  for (const patch of [{ id: 'running' }, { id: 'finished', activity: 'finished' as const }])
    expect(
      tracker.update(scope, [task({ ...patch, autoOpenTaskList: true })], true, {
        autoOpen: true,
      })[0]?.event,
    ).toBeNull();
  expect(
    tracker.update(scope, [task({ id: 'failed', activity: 'finished', failed: true })], true, {
      visible: true,
    })[0]?.event,
  ).toBe('taskFailure');
});

it('前台列表消费创建、暂停、恢复和完成，关闭后不补发；后台新结果照常提醒', async () => {
  render([]);
  render([task()], true);
  render([task({ activity: 'idle', paused: true })], true);
  render([task()], true);
  render([task({ activity: 'finished' })], true);
  render([task({ activity: 'finished' })]);
  expect(useToast.getState().toasts).toEqual([]);
  expect(rpc.notify).not.toHaveBeenCalled();
  render([task({ id: 'roaming:next' })], true);
  render([task({ id: 'roaming:next' })]);
  await act(async () => render([task({ id: 'roaming:next', activity: 'finished' })]));
  expect(useToast.getState().toasts.map((item) => item.event)).toEqual(['taskComplete']);
  expect(rpc.notify).toHaveBeenCalledOnce();
});

it('打开列表立即移除旧普通横幅，失败和等待处理不被吞掉，恢复后清掉旧警告', () => {
  render([]);
  render([task()]);
  expect(useToast.getState().toasts).toHaveLength(1);
  render([task()], true);
  expect(useToast.getState().toasts).toEqual([]);
  render([task({ waiting: true })], true);
  expect(useToast.getState().toasts[0]?.event).toBe('taskFailure');
  render([task()], true);
  expect(useToast.getState().leaving).toContain(useToast.getState().toasts[0]?.id);
});

it('轻量保存受理、通用进度和完成沿用同一条，迟到的受理不覆盖结果', async () => {
  render([]);
  act(() => notifyTaskCreated('save', '正在保存合成文件'));
  const id = useToast.getState().toasts[0]?.id;
  render([task()]);
  expect(useToast.getState().toasts).toHaveLength(1);
  expect(useToast.getState().toasts[0]?.id).toBe(id);
  await act(async () => render([task({ activity: 'finished' })]));
  act(() => notifyTaskCreated('save', '迟到的受理'));
  expect(useToast.getState().toasts[0]).toMatchObject({
    id,
    event: 'taskComplete',
    loading: false,
  });
  expect(rpc.notify).toHaveBeenCalledOnce();
});

it('受理早于首次任务快照时仍接上完成状态，不重放历史任务', () => {
  act(() => notifyTaskCreated('save', '正在保存合成文件'));
  render([task({ activity: 'finished' }), task({ id: 'old', activity: 'finished' })]);
  expect(useToast.getState().toasts).toHaveLength(1);
  expect(useToast.getState().toasts[0]?.event).toBe('taskComplete');
  expect(useToast.getState().toasts[0]?.key).toBe(taskNotificationKey(scope, 'export:save'));
});

it('列表留在失焦窗口不抑制后台完成，重新聚焦清除已在列表展示的成功结果', async () => {
  render([]);
  render([task()], true);
  act(() => {
    focused.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
  });
  await act(async () => render([task({ activity: 'finished' })], true));
  expect(useToast.getState().toasts[0]?.event).toBe('taskComplete');
  expect(rpc.notify).toHaveBeenCalledOnce();
  act(() => {
    focused.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
  });
  expect(useToast.getState().toasts).toEqual([]);
});

it('专用任务横幅也遵循列表可见性，不发重复系统通知，失败仍可见', async () => {
  render([], true);
  const source = notificationSource({
    kind: 'conversation',
    conversationKind: 'c2c',
    conv: 'u_fixture',
  });
  let id = 0;
  act(() => {
    id = useToast.getState().push({
      title: '正在转发',
      loading: true,
      source,
      dismissible: false,
      taskId: 'background:window:forward',
    });
  });
  expect(host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(true);
  await act(async () => {
    useToast.getState().update(id, {
      title: '转发完成',
      loading: false,
      dismissible: true,
      tone: 'success',
    });
  });
  expect(rpc.notify).not.toHaveBeenCalled();
  expect(useToast.getState().toasts).toEqual([]);
  act(() =>
    useToast.getState().push({
      event: 'taskFailure',
      title: '转发部分失败',
      tone: 'error',
      source,
      taskId: 'background:window:forward',
    }),
  );
  expect(host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(false);
});

it('其他账号或数据源的任务不因当前列表打开而被隐藏', () => {
  render([], true);
  const source = notificationSource({ kind: 'task', id: 'export:other' }, '查看任务', {
    expectedAccountUin: 'fixture',
    expectedAccountConfigId: 'other-source',
  });
  act(() => useToast.getState().push({ event: 'taskComplete', title: '其他来源完成', source }));
  expect(host.querySelector<HTMLElement>('.weq-toast')?.hidden).toBe(false);
});
