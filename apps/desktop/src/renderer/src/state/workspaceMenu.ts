import { create } from 'zustand';

interface WorkspaceMenuState {
  anchor: HTMLElement | null;
  running: number;
  failed: number;
  toggle: (anchor: HTMLElement) => void;
  close: () => void;
  setTasks: (running: number, failed: number) => void;
}

export const useWorkspaceMenu = create<WorkspaceMenuState>((set) => ({
  anchor: null,
  running: 0,
  failed: 0,
  toggle: (anchor) => set((state) => ({ anchor: state.anchor ? null : anchor })),
  close: () => set({ anchor: null }),
  setTasks: (running, failed) => set({ running, failed }),
}));
