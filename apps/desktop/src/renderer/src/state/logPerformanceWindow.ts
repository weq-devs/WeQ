import { create } from 'zustand';
import { focusToolPopup, openToolPopup } from '../hooks/useCompositionWindow';
import { useAppLock } from './lock';
import { MONITOR_WINDOWS, type MonitorTab } from '../../../shared/monitor_window';

export type { MonitorTab } from '../../../shared/monitor_window';
export interface MonitorWindowRequest {
  popup: Window | null;
  generation: number;
}
interface MonitorWindowState {
  requests: Partial<Record<MonitorTab, MonitorWindowRequest>>;
  open: (tab: MonitorTab) => void;
  dismiss: (tab?: MonitorTab, generation?: number) => void;
}

export const useLogPerformanceWindow = create<MonitorWindowState>((set, get) => ({
  requests: {},
  open: (tab) => {
    if (useAppLock.getState().locked) return;
    // 在用户点击内预开窗口，浏览器不会把后续挂载当成异步弹窗。
    const request = get().requests[tab];
    const previous = request?.popup;
    const popup =
      previous && !previous.closed
        ? previous
        : openToolPopup(
            MONITOR_WINDOWS[tab].name,
            MONITOR_WINDOWS[tab].width,
            MONITOR_WINDOWS[tab].height,
          );
    focusToolPopup(MONITOR_WINDOWS[tab].name, popup);
    const generation =
      request && request.popup === popup ? request.generation : (request?.generation ?? 0) + 1;
    set((state) => ({ requests: { ...state.requests, [tab]: { popup, generation } } }));
  },
  dismiss: (tab, generation) =>
    set((state) => {
      if (!tab) return { requests: {} };
      if (generation !== undefined && state.requests[tab]?.generation !== generation) return state;
      const requests = { ...state.requests };
      delete requests[tab];
      return { requests };
    }),
}));
