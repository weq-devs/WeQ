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
