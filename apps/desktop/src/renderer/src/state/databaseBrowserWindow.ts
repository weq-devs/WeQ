import { create } from 'zustand';
import { focusToolPopup, openToolPopup } from '../hooks/useCompositionWindow';
import { useAppLock } from './lock';
import { DATABASE_BROWSER_WINDOW } from '../../../shared/database_window';

export interface BrowserRequest {
  popup: Window | null;
  generation: number;
}
let nextGeneration = 0;
export const useDatabaseBrowserWindow = create<{
  request: BrowserRequest | null;
  open(): void;
  dismiss(generation?: number): void;
}>((set, get) => ({
  request: null,
  open: () => {
    if (useAppLock.getState().locked) return;
    const previous = get().request;
    const popup =
      previous?.popup && !previous.popup.closed
        ? previous.popup
        : openToolPopup(
            DATABASE_BROWSER_WINDOW.name,
            DATABASE_BROWSER_WINDOW.width,
            DATABASE_BROWSER_WINDOW.height,
          );
    focusToolPopup(DATABASE_BROWSER_WINDOW.name, popup);
    const generation =
      previous && previous.popup === popup ? previous.generation : ++nextGeneration;
    set({ request: { popup, generation } });
  },
  dismiss: (generation) =>
    set((state) =>
      generation !== undefined && state.request?.generation !== generation
        ? state
        : { request: null },
    ),
}));
