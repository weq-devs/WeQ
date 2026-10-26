import { create } from 'zustand';
import type { AssistantActivity, WorkspaceTaskIndicator } from '../lib/workspaceIndicators';
import { readWorkspaceResults, rememberWorkspaceResults } from '../lib/workspaceReadState';

interface WorkspaceMenuState {
  anchor: HTMLElement | null;
  running: number;
  failed: number;
  finished: number;
  assistant: AssistantActivity;
  assistantUnread: boolean;
  taskOpenRequest: number;
  openTasks: () => void;
  taskScope: string | null;
  taskItems: WorkspaceTaskIndicator[];
  readTaskResults: Record<string, string>;
  readTaskResultsByScope: Record<string, Record<string, string>>;
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
  setTasks: (running: number, failed: number, finished?: number) => void;
  setAssistant: (activity: AssistantActivity, unread?: boolean) => void;
  syncTasks: (scope: string, items: WorkspaceTaskIndicator[]) => void;
  readTasks: () => void;
}

export const useWorkspaceMenu = create<WorkspaceMenuState>((set) => ({
  anchor: null,
  running: 0,
  failed: 0,
  finished: 0,
  assistant: 'idle',
  assistantUnread: false,
  taskOpenRequest: 0,
  openTasks: () => set((state) => ({ taskOpenRequest: state.taskOpenRequest + 1 })),
  taskScope: null,
  taskItems: [],
  readTaskResults: {},
  readTaskResultsByScope: {},
  toggle: (anchor) => set((state) => ({ anchor: state.anchor ? null : anchor })),
  close: () => set({ anchor: null }),
  setTasks: (running, failed, finished = failed) => set({ running, failed, finished }),
  setAssistant: (assistant, unread = assistant === 'finished') =>
    set({ assistant, assistantUnread: unread }),
  syncTasks: (taskScope, taskItems) =>
    set((state) => {
      const readTaskResults: Record<string, string> = {};
      // 只保留仍在列表且结果未变化的已读记录，重新运行或重新保存后可以再次提醒。
      const previousRead =
        state.taskScope === taskScope
          ? state.readTaskResults
          : (state.readTaskResultsByScope[taskScope] ?? readWorkspaceResults(taskScope, 'tasks'));
      for (const item of taskItems) {
        if (item.activity === 'finished' && previousRead[item.id] === item.result)
          readTaskResults[item.id] = item.result;
      }
      rememberWorkspaceResults(taskScope, 'tasks', readTaskResults);
      return {
        taskScope,
        taskItems,
        readTaskResults,
        readTaskResultsByScope: { ...state.readTaskResultsByScope, [taskScope]: readTaskResults },
        running: taskItems.filter((item) => item.activity === 'running').length,
        failed: taskItems.filter((item) => item.failed).length,
        finished: taskItems.filter(
          (item) => item.activity === 'finished' && readTaskResults[item.id] !== item.result,
        ).length,
      };
    }),
  readTasks: () =>
    set((state) => {
      const readTaskResults = Object.fromEntries(
        state.taskItems
          .filter((item) => item.activity === 'finished')
          .map((item) => [item.id, item.result]),
      );
      if (state.taskScope) rememberWorkspaceResults(state.taskScope, 'tasks', readTaskResults);
      return {
        finished: 0,
        readTaskResults,
        readTaskResultsByScope: state.taskScope
          ? { ...state.readTaskResultsByScope, [state.taskScope]: readTaskResults }
          : state.readTaskResultsByScope,
      };
    }),
}));
