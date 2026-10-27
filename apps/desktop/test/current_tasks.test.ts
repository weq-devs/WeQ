import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrentTaskList } from '../src/renderer/src/components/tasks/CurrentTaskList';
import {
  LongTaskRow,
  orderLongTasks,
  type LongTaskItem,
} from '../src/renderer/src/components/tasks/LongTaskRow';
import type { UiTask } from '../src/renderer/src/views/export/TaskList';
import { renderToStaticMarkup } from 'react-dom/server';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { dismissCloneTask, getCloneTasks } from '../src/renderer/src/views/agentlab/cloneTaskStore';

const fixture = vi.hoisted(() => ({
  accountId: 'fixture-account',
  roamingStatus: 'partial',
  plannedSeqs: 100,
  flashStatus: 'pending',
  confirm: vi.fn(async () => false),
  clear: vi.fn(async () => ({ removed: 3, skipped: 0, errors: [] as string[] })),
  invalidate: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (state: { openedUin: string }) => unknown) =>
    select({ openedUin: fixture.accountId }),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (state: unknown) => unknown) =>
    select({
      confirm: fixture.confirm,
      showInfo: fixture.info,
      showError: fixture.error,
    }),
}));
vi.mock('../src/renderer/src/components/RoamingBackfillPanel', () => ({
  RoamingBackfillPanel: ({ taskId }: { taskId: string }) => h('span', null, `漫游详情 ${taskId}`),
}));
vi.mock('../src/renderer/src/views/agentlab/cloneTaskStore', () => {
  const tasks = [
    {
      personaId: 'same-id',
      accountId: 'fixture-account',
      name: '合成克隆',
      status: 'running',
      phase: '训练中',
      percent: 25,
    },
  ];
  return {
    getCloneTasks: () => tasks,
    subscribeCloneTasks: () => () => {},
    dismissCloneTask: vi.fn(),
  };
});
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { clearCompletedTasks: { mutate: fixture.clear } } },
  trpc: {
    useUtils: () => ({
      account: {
        flashListDownloadTasks: { invalidate: fixture.invalidate },
        listExportTasks: { invalidate: fixture.invalidate },
        getExportOutputReceipt: { invalidate: fixture.invalidate },
        roamingBackfill: { list: { invalidate: fixture.invalidate } },
      },
    }),
    account: {
      roamingBackfill: {
        list: {
          useQuery: () => ({
            data: {
              jobs: [
                {
                  id: 'same-id',
                  targets: [{ name: '合成漫游' }],
                  status: fixture.roamingStatus,
                  plannedSeqs: fixture.plannedSeqs,
                  remainingSeqs: fixture.plannedSeqs > 0 ? 75 : 0,
                },
              ],
            },
          }),
        },
      },
      flashListDownloadTasks: {
        useQuery: () => ({
          data: [
            {
              id: 'same-id',
              name: '合成闪传',
              status: fixture.flashStatus,
              fileSize: 100,
              downloadedBytes: 0,
              filesetName: '合成集合',
              relativePath: 'fixture.txt',
              targetPath: '/fixture',
            },
          ],
        }),
      },
      flashCancelDownloadTask: { useMutation: () => ({ mutate: vi.fn() }) },
      flashRevealDownloadDir: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

afterEach(() => {
  fixture.accountId = 'fixture-account';
  fixture.roamingStatus = 'partial';
  fixture.plannedSeqs = 100;
  fixture.flashStatus = 'pending';
  getCloneTasks()[0]!.status = 'running';
  vi.clearAllMocks();
  fixture.confirm.mockResolvedValue(false);
  vi.unstubAllGlobals();
});

describe('统一当前任务', () => {
  it('没有候选缺口时只显示检查结果，不显示缺口已覆盖', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.roamingStatus = 'completed';
    fixture.plannedSeqs = 0;
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(CurrentTaskList, { exports: [], onSaveAll: vi.fn(), renderExport: () => null }),
        ),
      );
      expect(host.textContent).toContain('未发现可补全的缺口');
      expect(host.textContent).not.toContain('候选缺口已覆盖');
    } finally {
      act(() => root.unmount());
    }
  });

  it('计入当前账号的完成克隆，清除失败时保留记录并恢复按钮', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    getCloneTasks()[0]!.status = 'done';
    const host = document.createElement('div');
    const root = createRoot(host);
    const props = {
      cleanupBinding: {
        expectedAccountUin: 'fixture-account',
        expectedAccountConfigId: 'fixture-config',
      },
      exports: [],
      onSaveAll: vi.fn(),
      renderExport: () => null,
    };
    fixture.confirm.mockResolvedValue(true);
    fixture.clear.mockRejectedValueOnce(new Error('写入失败'));
    try {
      act(() => root.render(h(CurrentTaskList, props)));
      const button = () => host.querySelector<HTMLButtonElement>('[aria-label="清除已完成任务"]')!;
      await act(async () => button().click());
      expect(fixture.confirm).toHaveBeenCalledWith(
        '清除已完成任务',
        expect.stringContaining('确定清除 1 项'),
        expect.anything(),
      );
      expect(dismissCloneTask).not.toHaveBeenCalled();
      expect(fixture.error).toHaveBeenCalledWith('清除失败', '写入失败');
      expect(button().disabled).toBe(false);
      fixture.clear.mockResolvedValueOnce({ removed: 0, skipped: 0, errors: [] });
      await act(async () => button().click());
      expect(dismissCloneTask).toHaveBeenCalledWith('same-id');
      expect(fixture.info).toHaveBeenCalledWith('清除完成', '已清除 1 项任务。');
      getCloneTasks()[0]!.status = 'running';
      act(() => root.render(h(CurrentTaskList, props)));
      expect(button().disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it('清除前确认项目数并提示未保存结果，取消不执行；确认只传完成任务快照', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.roamingStatus = 'completed';
    fixture.flashStatus = 'done';
    const host = document.createElement('div');
    const root = createRoot(host);
    const task: UiTask = {
      id: 'done',
      name: '未保存导出',
      kind: 'c2c',
      format: 'json',
      status: 'completed',
      progress: 100,
      current: 1,
      total: 1,
    };
    const binding = {
      expectedAccountUin: 'fixture-account',
      expectedAccountConfigId: 'fixture-config',
    };
    const render = (cleanupBinding = binding) =>
      root.render(
        h(CurrentTaskList, {
          cleanupBinding,
          exports: [
            task,
            { ...task, id: 'saving', save: { status: 'saving' } },
            { ...task, id: 'failed', status: 'failed' },
          ],
          onSaveAll: vi.fn(),
          renderExport: () => null,
        }),
      );
    try {
      act(() => render());
      const button = () => host.querySelector<HTMLButtonElement>('[aria-label="清除已完成任务"]')!;
      await act(async () => button().click());
      expect(fixture.confirm).toHaveBeenCalledWith(
        '清除已完成任务',
        expect.stringContaining('确定清除 3 项'),
        expect.objectContaining({ okLabel: '清除 3 项' }),
      );
      expect(fixture.confirm.mock.calls[0]?.[1]).toContain('1 项导出尚未保存');
      expect(fixture.clear).not.toHaveBeenCalled();
      fixture.confirm.mockResolvedValue(true);
      await act(async () => button().click());
      expect(fixture.clear).toHaveBeenCalledOnce();
      expect(fixture.clear).toHaveBeenCalledWith({
        ...binding,
        exports: ['done'],
        roaming: ['same-id'],
        flash: ['same-id'],
      });
      expect(fixture.invalidate).toHaveBeenCalledTimes(4);
      expect(fixture.info).toHaveBeenCalledWith('清除完成', '已清除 3 项任务。');
      let resolve = (_ok: boolean) => {};
      fixture.confirm.mockImplementationOnce(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );
      act(() => button().click());
      expect(button().disabled).toBe(true);
      act(() => render({ ...binding, expectedAccountConfigId: 'another-config' }));
      await act(async () => resolve(true));
      expect(fixture.clear).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('隐藏或尚未加载的任务列表不清红点，查看列表后清除红点但保留蓝点', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const items = [
      { id: 'export:done', activity: 'finished' as const, result: 'completed', failed: false },
      { id: 'clone:running', activity: 'running' as const, result: 'running', failed: false },
    ];
    const store = useWorkspaceMenu.getState();
    store.syncTasks('read-fixture', items);
    const render = (active: boolean, loadingExports = false) =>
      act(() =>
        root.render(
          h(
            TabActivity,
            { active },
            h(CurrentTaskList, {
              exports: [],
              loadingExports,
              renderExport: () => null,
              onSaveAll: vi.fn(),
            }),
          ),
        ),
      );
    try {
      render(false);
      expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 1, running: 1 });
      render(true, true);
      expect(useWorkspaceMenu.getState().finished).toBe(1);
      render(true);
      expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
      render(false);
      act(() =>
        store.syncTasks('read-fixture', [
          ...items,
          { id: 'flash:new', activity: 'finished', result: 'done', failed: false },
        ]),
      );
      expect(useWorkspaceMenu.getState().finished).toBe(1);
      render(true);
      expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
    } finally {
      act(() => root.unmount());
    }
  });

  it('菜单只显示列表，点击任务展开同一个选中项，完整面板右侧呈现详情', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const expand = vi.fn();
    const render = (layout: 'compact' | 'split') =>
      root.render(
        h(CurrentTaskList, {
          layout,
          exports: [],
          onSaveAll: vi.fn(),
          renderExport: () => null,
          onOpenDetail: expand,
        }),
      );
    try {
      act(() => render('compact'));
      expect(host.querySelector('.weq-long-task-detail')).toBeNull();
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('.weq-long-task')]
          .find((button) => button.textContent?.includes('合成漫游'))!
          .click(),
      );
      expect(expand).toHaveBeenCalledOnce();
      act(() => render('split'));
      expect(host.querySelector('.weq-current-task-details')?.textContent).toBe('漫游详情 same-id');
      expect(host.querySelector('.weq-long-task.is-selected')?.textContent).toContain('合成漫游');
    } finally {
      act(() => root.unmount());
    }
  });
  it('跨来源相同 ID 不冲突，按运行状态聚合且详情不串任务', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const task: UiTask = {
      id: 'same-id',
      name: '合成导出',
      kind: 'c2c',
      format: 'json',
      status: 'completed',
      progress: 100,
      current: 1,
      total: 1,
    };
    const render = () =>
      root.render(
        h(CurrentTaskList, {
          exports: [task],
          onSaveAll: vi.fn(),
          renderExport: (item) => h('span', null, `导出详情 ${item.name}`),
        }),
      );
    try {
      act(render);
      expect(
        [...host.querySelectorAll('.weq-long-task-name')].map((node) => node.textContent),
      ).toEqual(['合成克隆', '合成闪传', '合成漫游', '合成导出']);
      expect(host.querySelector('.weq-long-task-detail')?.textContent).toContain('训练中');
      const rows = host.querySelectorAll<HTMLButtonElement>('.weq-long-task');
      act(() => rows[2]!.click());
      expect(host.querySelector('.weq-long-task-detail')?.textContent).toBe('漫游详情 same-id');
      expect(rows[2]!.textContent).toContain('仍有缺口');
      expect(rows[2]!.querySelector('progress')?.value).toBe(25);
      act(() => rows[3]!.click());
      expect(host.querySelector('.weq-long-task-detail')?.textContent).toBe('导出详情 合成导出');
      fixture.accountId = 'other-account';
      act(render);
      expect(host.textContent).not.toContain('合成克隆');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('排序不修改输入，同状态保持顺序，未知进度不伪装百分比', () => {
    const base: LongTaskItem = {
      id: 'done',
      name: '合成任务',
      kind: '合成',
      status: 'completed',
      icon: null,
      detail: null,
    };
    const input = [
      base,
      { ...base, id: 'running-a', status: 'running' as const },
      { ...base, id: 'running-b', status: 'running' as const },
    ];
    expect(orderLongTasks(input).map((item) => item.id)).toEqual([
      'running-a',
      'running-b',
      'done',
    ]);
    expect(input[0]!.id).toBe('done');
    const markup = renderToStaticMarkup(
      h(LongTaskRow, {
        task: input[1]!,
        active: true,
        onSelect: vi.fn(),
      }),
    );
    expect(markup).toContain('<progress');
    expect(markup).not.toContain('value=');
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('%');
  });
});
