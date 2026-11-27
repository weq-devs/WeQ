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
  readTask: (scope: string, id: string, result: string) => void;
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
        if (item.activity === 'finished' && item.resultSeen && !item.archived)
          previousRead[item.id] = item.result;
        else if (item.activity !== 'finished' || previousRead[item.id] !== item.result)
          delete previousRead[item.id];
      }
      const readResults = retainTaskResults(previousRead);
      // 首次读取、账号切换及已读历史回填不展开列表，后台步骤也不抢占界面。
      const hasNewTask =
        state.taskScope === taskScope &&
        taskItems.some(
          (item) =>
            !item.archived &&
            item.autoOpenTaskList !== false &&
            !previousIds.has(item.id) &&
            !(item.activity === 'finished' && readResults[item.id] === item.result),
        );
      const unreadResults = taskItems.filter(
        (item) =>
          item.activity === 'finished' &&
          !item.archived &&
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
  readTask: (scope, id, result) =>
    set((state) => {
      if (
        state.taskScope !== scope ||
        state.readTaskResults[id] === result ||
        !state.taskItems.some(
          (item) =>
            item.id === id &&
            item.activity === 'finished' &&
            item.result === result &&
            !item.waiting,
        )
      )
        return state;
      const results = {
        ...state.readTaskResults,
        ...readTaskResults(scope),
        [id]: result,
      };
      const readResults = retainTaskResults(results);
      rememberTaskResults(scope, readResults);
      const unread = state.taskItems.filter(
        (item) =>
          item.activity === 'finished' &&
          !item.archived &&
          item.showResultBadge !== false &&
          readResults[item.id] !== item.result,
      );
      return {
        finished: unread.length,
        unreadFailed: unread.filter((item) => item.failed).length,
        readTaskResults: readResults,
        readTaskResultsByScope: { ...state.readTaskResultsByScope, [scope]: readResults },
      };
    }),
}));
