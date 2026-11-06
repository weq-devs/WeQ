import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
import type { WorkspaceTaskIndicator } from '../src/renderer/src/lib/workspaceIndicators';
import { summarizeWorkspaceTasks } from '../src/renderer/src/lib/workspaceIndicators';

const task = (
  id: string,
  activity: WorkspaceTaskIndicator['activity'] = 'finished',
  result = 'completed',
): WorkspaceTaskIndicator => ({ id, activity, result, failed: false });
function resetMemory() {
  useWorkspaceMenu.setState({
    taskScope: null,
    taskItems: [],
    readTaskResults: {},
    readTaskResultsByScope: {},
    running: 0,
    finished: 0,
    failed: 0,
  });
}
beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  resetMemory();
});
afterEach(() => vi.unstubAllGlobals());

describe('任务结果已读状态', () => {
  it('后台步骤和漫游子任务不展开列表，仍保留计数、失败与手动打开入口', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('quiet', []);
    const initial = useWorkspaceMenu.getState().taskOpenRequest;
    const summary = summarizeWorkspaceTasks({
      background: [{ id: 'scan', status: 'running', updatedAt: 1 }],
      scanning: true,
      roaming: [{ id: 'child', status: 'running' }],
    });
    store.syncTasks('quiet', summary.items);
    expect(useWorkspaceMenu.getState()).toMatchObject({ taskOpenRequest: initial, running: 3 });
    store.syncTasks(
      'quiet',
      summarizeWorkspaceTasks({
        background: [{ id: 'scan', status: 'failed', updatedAt: 2 }],
      }).items,
    );
    expect(useWorkspaceMenu.getState()).toMatchObject({
      taskOpenRequest: initial,
      running: 0,
      finished: 1,
      failed: 1,
    });
    store.openTasks();
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 1);
  });

  it.each([
    'media',
    'market-image',
    'decoration',
    'group-albums',
    'qzone-albums',
    'group-files',
    'mail-attachment',
  ] as const)('单文件快捷保存 %s 不展开列表，批量导出保持原行为', (kind) => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('save', []);
    const initial = useWorkspaceMenu.getState().taskOpenRequest;
    store.syncTasks(
      'save',
      summarizeWorkspaceTasks({
        exports: [
          {
            id: 'single',
            status: 'completed',
            resource: { kind, output: { kind: 'file', name: 'fixture', extension: 'png' } },
          },
        ],
      }).items,
    );
    expect(useWorkspaceMenu.getState()).toMatchObject({ taskOpenRequest: initial, finished: 1 });
    store.syncTasks(
      'save',
      summarizeWorkspaceTasks({
        exports: [
          {
            id: 'batch',
            status: 'running',
            resource: { kind },
          },
        ],
      }).items,
    );
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 1);
  });

  it('定时自动导出不弹出，手动导出、报告、克隆和闪传继续弹出', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('exports', []);
    const initial = useWorkspaceMenu.getState().taskOpenRequest;
    store.syncTasks(
      'exports',
      summarizeWorkspaceTasks({
        exports: [
          {
            id: 'scheduled',
            status: 'running',
            autoOpenTaskList: false,
          },
        ],
      }).items,
    );
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial);
    for (const summary of [
      summarizeWorkspaceTasks({ exports: [{ id: 'manual', status: 'running' }] }),
      summarizeWorkspaceTasks({
        exports: [
          {
            id: 'report',
            status: 'running',
            resource: {
              kind: 'annual-report',
              output: { kind: 'file', name: 'report', extension: 'html' },
            },
          },
        ],
      }),
      summarizeWorkspaceTasks({ clones: [{ personaId: 'clone', status: 'running' }] }),
      summarizeWorkspaceTasks({ flash: [{ id: 'flash', status: 'downloading' }] }),
    ])
      store.syncTasks('exports', summary.items);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 4);
  });

  it('首次加载和切换账号不弹出，同账号新增任务自动打开，刷新和进度变化不重复弹出', () => {
    const store = useWorkspaceMenu.getState();
    const initial = store.taskOpenRequest;
    store.syncTasks('auto-open-a', [task('old')]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial);
    store.syncTasks('auto-open-a', [task('new', 'running')]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 1);
    store.syncTasks('auto-open-a', [task('new', 'running', 'progress')]);
    store.syncTasks('auto-open-a', [task('new')]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 1);
    store.syncTasks('auto-open-b', [task('other')]);
    store.syncTasks('auto-open-a', [task('new')]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 1);
    // 快速完成的任务也可能在第一次轮询时已经结束。
    store.syncTasks('auto-open-a', [task('new'), task('fast')]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(initial + 2);
  });

  it('重启后恢复已读结果，仍区分新结果、在途任务和其他账号', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('persist-a', [task('1'), task('2', 'running')]);
    store.readTasks();
    resetMemory();
    store.syncTasks('persist-a', [task('1'), task('2', 'running')]);
    expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
    store.syncTasks('persist-b', [task('1')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
    resetMemory();
    store.syncTasks('persist-a', [task('1', 'finished', 'new-result'), task('2')]);
    expect(useWorkspaceMenu.getState().finished).toBe(2);
  });

  it('重新运行会作废持久化已读结果，重启后结束仍提醒', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('persist-rerun', [task('1')]);
    store.readTasks();
    store.syncTasks('persist-rerun', [task('1', 'running')]);
    resetMemory();
    store.syncTasks('persist-rerun', [task('1')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
  });

  it('未采样到运行阶段时，按结果时间区分同一任务的新一轮完成', () => {
    const store = useWorkspaceMenu.getState();
    const snapshot = (updatedAt: number) =>
      summarizeWorkspaceTasks({ exports: [{ id: 'same', status: 'completed', updatedAt }] }).items;
    store.syncTasks('a', snapshot(100));
    store.readTasks();
    store.syncTasks('a', snapshot(100));
    expect(useWorkspaceMenu.getState().finished).toBe(0);
    store.syncTasks('a', snapshot(200));
    expect(useWorkspaceMenu.getState().finished).toBe(1);
  });

  it('查看仅清除红点，刷新、排序和跨账号返回不恢复旧红点', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('a', [task('1'), task('2'), task('3', 'running')]);
    expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 2, running: 1 });
    store.readTasks();
    expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
    store.syncTasks('a', [task('2'), task('3', 'running'), task('1')]);
    expect(useWorkspaceMenu.getState().finished).toBe(0);
    store.syncTasks('b', [task('1')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
    store.syncTasks('a', [task('1'), task('2'), task('3', 'running')]);
    expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
  });

  it('数量相同但换了任务仍提醒，重新运行、重新保存或结果变化再次提醒', () => {
    const store = useWorkspaceMenu.getState();
    store.syncTasks('a', [task('1')]);
    store.readTasks();
    store.syncTasks('a', [task('2')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
    store.readTasks();
    store.syncTasks('a', [task('2', 'running')]);
    expect(useWorkspaceMenu.getState()).toMatchObject({ finished: 0, running: 1 });
    store.syncTasks('a', [task('2')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
    store.readTasks();
    store.syncTasks('a', [task('2', 'finished', 'completed:saved')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
    store.readTasks();
    store.syncTasks('a', []);
    store.syncTasks('a', [task('2')]);
    expect(useWorkspaceMenu.getState().finished).toBe(1);
  });
});
