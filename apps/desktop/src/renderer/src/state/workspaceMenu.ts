import { create } from 'zustand';
import type { AssistantActivity } from '../lib/workspaceIndicators';

interface WorkspaceMenuState {
  anchor: HTMLElement | null;
  running: number;
  failed: number;
  finished: number;
  assistant: AssistantActivity;
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
  setTasks: (running: number, failed: number, finished?: number) => void;
  setAssistant: (activity: AssistantActivity) => void;
}

export const useWorkspaceMenu = create<WorkspaceMenuState>((set) => ({
  anchor: null,
  running: 0,
  failed: 0,
  finished: 0,
  assistant: 'idle',
  toggle: (anchor) => set((state) => ({ anchor: state.anchor ? null : anchor })),
  close: () => set({ anchor: null }),
  setTasks: (running, failed, finished = failed) => set({ running, failed, finished }),
  setAssistant: (assistant) => set({ assistant }),
}));
