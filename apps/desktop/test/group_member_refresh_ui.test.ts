import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGroupMemberRefresh } from '../src/renderer/src/hooks/useGroupMemberRefresh';

const state = vi.hoisted(() => ({
  uin: '99999',
  status: 'completed',
  target: 'metrics',
  revision: 0,
  onData: undefined as undefined | ((event: { base: boolean; relationGraph?: boolean }) => void),
  mutate: vi.fn(async (_input: unknown) => 'synthetic-task'),
  invalidateGraph: vi.fn(async () => {}),
  invalidateSnapshot: vi.fn(async (_binding: unknown) => {}),
  focusTask: vi.fn(),
  showError: vi.fn(),
  confirm: vi.fn(async (_title: string, _message: string, _options: unknown) => true),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign((select) => select({ openedUin: state.uin }), {
    getState: () => ({ openedUin: state.uin }),
  }),
}));
vi.mock('../src/renderer/src/state/workspaceMenu', () => ({
  useWorkspaceMenu: { getState: () => ({ focusTask: state.focusTask }) },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select) => select({ showError: state.showError, confirm: state.confirm }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        getRelationGraph: { invalidate: state.invalidateGraph },
        contactMetrics: { status: { invalidate: state.invalidateSnapshot } },
      },
    }),
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: state.uin, configId: 'synthetic' } }) },
      contactMetrics: {
        status: {
          useQuery: () => ({
            data: {
              target: state.target,
              progress: { status: state.status },
              relationGraphRevision: state.revision,
            },
          }),
        },
        changed: {
          useSubscription: (_input, options) => {
            state.onData = options.onData;
          },
        },
        rebuild: { useMutation: () => ({ mutateAsync: state.mutate, isLoading: false }) },
      },
    },
  },
}));

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.status = 'completed';
  state.target = 'metrics';
  state.revision = 0;
  state.uin = '99999';
  state.mutate.mockResolvedValue('synthetic-task');
  state.confirm.mockResolvedValue(true);
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});
function render() {
  function Fixture() {
    const refresh = useGroupMemberRefresh();
    return h(
      'button',
      { disabled: refresh.refreshing || !refresh.ready, onClick: refresh.refresh },
      '更新成员',
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const rerender = () => act(() => root.render(h(Fixture)));
  rerender();
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { button: host.querySelector('button')!, rerender };
}

it('打开页面不更新名单，主动刷新只启动群成员范围任务并打开同一任务面板', async () => {
  const { button } = render();
  expect(state.mutate).not.toHaveBeenCalled();
  await act(async () => {
    button.click();
  });
  expect(state.confirm).toHaveBeenCalledWith(
    '更新全部群成员？',
    expect.stringContaining('不更新群资料或好友信息'),
    { okLabel: '更新并重新计算', cancelLabel: '取消', tone: 'info' },
  );
  expect(state.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '99999',
    expectedAccountConfigId: 'synthetic',
    target: 'groupMembers',
    range: 'all',
    missingOnly: false,
  });
  expect(state.focusTask).toHaveBeenCalledWith('background:host:synthetic-task');
  expect(state.invalidateGraph).not.toHaveBeenCalled();
});

it('等待确认时不启动，取消确认不创建任务', async () => {
  let answer!: (value: boolean) => void;
  state.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const { button } = render();
  await act(async () => {
    button.click();
  });
  expect(state.mutate).not.toHaveBeenCalled();
  await act(async () => {
    answer(false);
  });
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.focusTask).not.toHaveBeenCalled();
});

it('确认期间切换账号不启动旧账号任务', async () => {
  let answer!: (value: boolean) => void;
  state.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const { button } = render();
  await act(async () => {
    button.click();
  });
  state.uin = '88888';
  await act(async () => {
    answer(true);
  });
  expect(state.mutate).not.toHaveBeenCalled();
});

it('通知只校准轻量状态，新计算版本才更新图谱；运行和离线暂停时防止重复启动', () => {
  const { button, rerender } = render();
  state.onData!({ base: false });
  expect(state.invalidateGraph).not.toHaveBeenCalled();
  state.onData!({ base: false, relationGraph: true });
  expect(state.invalidateGraph).not.toHaveBeenCalled();
  state.revision = 1;
  rerender();
  expect(state.invalidateGraph).toHaveBeenCalledTimes(1);
  state.target = 'groupMembers';
  state.status = 'running';
  rerender();
  expect(button.disabled).toBe(true);
  state.status = 'paused';
  rerender();
  expect(button.disabled).toBe(true);
  state.status = 'failed';
  rerender();
  expect(button.disabled).toBe(false);
  expect(state.invalidateGraph).toHaveBeenCalledTimes(1);
});

it('启动失败明确提示，不把失败冒充刷新成功', async () => {
  state.mutate.mockRejectedValueOnce(new Error('另一范围的任务正在进行'));
  const { button } = render();
  await act(async () => {
    button.click();
  });
  expect(state.showError).toHaveBeenCalledWith('群成员更新启动失败', '另一范围的任务正在进行');
  expect(state.focusTask).not.toHaveBeenCalled();
  expect(state.invalidateGraph).not.toHaveBeenCalled();
});
