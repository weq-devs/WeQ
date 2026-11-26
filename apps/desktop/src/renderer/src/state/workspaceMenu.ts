import { create } from 'zustand';
import type { WorkspaceTaskIndicator } from '../lib/workspaceIndicators';
import { readTaskResults, rememberTaskResults } from '../lib/workspaceReadState';
import type { NavigationTool } from '../lib/appNavigation';

export const TASK_READ_LIMIT = 4096;
export type MobileWorkspaceTool = NavigationTool | 'composition';

function retainTaskResults(results: Record<string, string>) {
  return Object.fromEntries(Object.entries(results).slice(-TASK_READ_LIMIT));
}

interface WorkspaceMenuState {
  anchor: HTMLElement | null;
  running: number;
  unreadFailed: number;
  finished: number;
  taskOpenRequest: number;
  taskFocusId: string | null;
  taskPanelScope: string | null;
  setTaskPanelScope: (scope: string | null) => void;
  focusTask: (id: string) => void;
  openTasks: () => void;
  mobileToolRequest: { tool: MobileWorkspaceTool } | null;
  openMobileTool: (tool: MobileWorkspaceTool) => void;
  taskScope: string | null;
  taskItems: WorkspaceTaskIndicator[];
  readTaskResults: Record<string, string>;
  readTaskResultsByScope: Record<string, Record<string, string>>;
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
  resetTaskBadges: () => void;
  syncTasks: (scope: string, items: WorkspaceTaskIndicator[]) => void;
  readTasks: () => void;
}

export const useWorkspaceMenu = create<WorkspaceMenuState>((set) => ({
  anchor: null,
  running: 0,
  unreadFailed: 0,
  finished: 0,
  taskOpenRequest: 0,
  taskFocusId: null,
  taskPanelScope: null,
  setTaskPanelScope: (taskPanelScope) =>
    set((state) => (state.taskPanelScope === taskPanelScope ? state : { taskPanelScope })),
  focusTask: (id) =>
    set((state) => ({ taskFocusId: id, taskOpenRequest: state.taskOpenRequest + 1 })),
  openTasks: () =>
    set((state) => ({ taskFocusId: null, taskOpenRequest: state.taskOpenRequest + 1 })),
  mobileToolRequest: null,
  openMobileTool: (tool) => set({ mobileToolRequest: { tool } }),
  taskScope: null,
  taskItems: [],
  readTaskResults: {},
  readTaskResultsByScope: {},
  toggle: (anchor) => set((state) => ({ anchor: state.anchor ? null : anchor })),
  close: () => set({ anchor: null }),
  resetTaskBadges: () => set({ running: 0, unreadFailed: 0, finished: 0 }),
  syncTasks: (taskScope, taskItems) =>
    set((state) => {
      const previousIds = new Set(state.taskItems.map((item) => item.id));
      // 空列表或部分加载不表示任务已删除；每次合并其他窗口的已读，避免旧快照覆盖。
      const previousRead = {
        ...(state.readTaskResultsByScope[taskScope] ?? {}),
        ...(state.taskScope === taskScope ? state.readTaskResults : {}),
        ...readTaskResults(taskScope),
      };
      for (const item of taskItems) {
        if (item.activity !== 'finished' || previousRead[item.id] !== item.result)
          delete previousRead[item.id];
      }
      const readResults = retainTaskResults(previousRead);
      // 首次读取、账号切换及已读历史回填不展开列表，后台步骤也不抢占界面。
      const hasNewTask =
        state.taskScope === taskScope &&
        taskItems.some(
          (item) =>
            item.autoOpenTaskList !== false &&
            !previousIds.has(item.id) &&
            !(item.activity === 'finished' && readResults[item.id] === item.result),
        );
      const unreadResults = taskItems.filter(
        (item) =>
          item.activity === 'finished' &&
          item.showResultBadge !== false &&
          readResults[item.id] !== item.result,
      );
      rememberTaskResults(taskScope, readResults);
      return {
        taskScope,
        taskItems,
        taskOpenRequest: state.taskOpenRequest + Number(hasNewTask),
        readTaskResults: readResults,
        readTaskResultsByScope: { ...state.readTaskResultsByScope, [taskScope]: readResults },
        running: taskItems.filter(
          (item) => item.activity === 'running' && item.showRunningBadge !== false,
        ).length,
        unreadFailed: unreadResults.filter((item) => item.failed).length,
        finished: unreadResults.length,
      };
    }),
  readTasks: () =>
    set((state) => {
      const results = {
        ...state.readTaskResults,
        ...(state.taskScope ? readTaskResults(state.taskScope) : {}),
      };
      for (const item of state.taskItems) {
        delete results[item.id];
        if (item.activity === 'finished') results[item.id] = item.result;
      }
      const readResults = retainTaskResults(results);
      if (state.taskScope) rememberTaskResults(state.taskScope, readResults);
      return {
        finished: 0,
        unreadFailed: 0,
        readTaskResults: readResults,
        readTaskResultsByScope: state.taskScope
          ? { ...state.readTaskResultsByScope, [state.taskScope]: readResults }
          : state.readTaskResultsByScope,
      };
    }),
}));
