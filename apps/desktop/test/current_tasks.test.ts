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

const fixture = vi.hoisted(() => ({ accountId: 'fixture-account' }));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (select: (state: { openedUin: string }) => unknown) =>
    select({ openedUin: fixture.accountId }),
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQReadActivity: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => vi.fn() }));
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
  trpc: {
    useUtils: () => ({ account: { flashListDownloadTasks: { invalidate: vi.fn() } } }),
    account: {
      roamingBackfill: {
        list: {
          useQuery: () => ({
            data: {
              jobs: [
                {
                  id: 'same-id',
                  targets: [{ name: '合成漫游' }],
                  status: 'partial',
                  plannedSeqs: 100,
                  remainingSeqs: 75,
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
              status: 'pending',
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
  vi.unstubAllGlobals();
});

describe('统一当前任务', () => {
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
