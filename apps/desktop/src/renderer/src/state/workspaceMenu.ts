import { create } from 'zustand';
import type { AssistantActivity, WorkspaceTaskIndicator } from '../lib/workspaceIndicators';
import { readWorkspaceResults, rememberWorkspaceResults } from '../lib/workspaceReadState';

export const TASK_READ_LIMIT = 4096;
export type MobileWorkspaceTool =
  | 'tasks'
  | 'assistant'
  | 'analysis'
  | 'export'
  | 'viewer'
  | 'composition';

function retainTaskResults(results: Record<string, string>) {
  return Object.fromEntries(Object.entries(results).slice(-TASK_READ_LIMIT));
}

interface WorkspaceMenuState {
  anchor: HTMLElement | null;
  running: number;
  failed: number;
  finished: number;
  assistant: AssistantActivity;
  assistantUnread: boolean;
  taskOpenRequest: number;
  openTasks: () => void;
  mobileToolRequest: { tool: MobileWorkspaceTool } | null;
  openMobileTool: (tool: MobileWorkspaceTool) => void;
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
  mobileToolRequest: null,
  openMobileTool: (tool) => set({ mobileToolRequest: { tool } }),
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
      const previousIds = new Set(state.taskItems.map((item) => item.id));
      // 空列表或部分加载不表示任务已删除；每次合并其他窗口的已读，避免旧快照覆盖。
      const previousRead = {
        ...(state.readTaskResultsByScope[taskScope] ?? {}),
        ...(state.taskScope === taskScope ? state.readTaskResults : {}),
        ...readWorkspaceResults(taskScope, 'tasks'),
      };
      for (const item of taskItems) {
        if (item.activity !== 'finished' || previousRead[item.id] !== item.result)
          delete previousRead[item.id];
      }
      const readTaskResults = retainTaskResults(previousRead);
      // 首次读取、账号切换及已读历史回填不展开列表，后台步骤也不抢占界面。
      const hasNewTask =
        state.taskScope === taskScope &&
        taskItems.some(
          (item) =>
            item.autoOpenTaskList !== false &&
            !previousIds.has(item.id) &&
            !(item.activity === 'finished' && readTaskResults[item.id] === item.result),
        );
      rememberWorkspaceResults(taskScope, 'tasks', readTaskResults);
      return {
        taskScope,
        taskItems,
        taskOpenRequest: state.taskOpenRequest + Number(hasNewTask),
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
      const results = {
        ...state.readTaskResults,
        ...(state.taskScope ? readWorkspaceResults(state.taskScope, 'tasks') : {}),
      };
      for (const item of state.taskItems) {
        delete results[item.id];
        if (item.activity === 'finished') results[item.id] = item.result;
      }
      const readTaskResults = retainTaskResults(results);
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
