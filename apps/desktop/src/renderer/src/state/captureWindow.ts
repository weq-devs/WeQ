import { create } from 'zustand';
import { useAppLock } from './lock';

export interface CaptureWindowRequest {
  source: string;
  uin: string;
}

interface CaptureWindowState {
  request: CaptureWindowRequest | null;
  open: (source: string, uin?: string) => void;
  dismiss: (source?: string) => void;
}

export const useCaptureWindow = create<CaptureWindowState>((set) => ({
  request: null,
  open: (source, uin = '') => {
    if (source && !useAppLock.getState().locked) set({ request: { source, uin } });
  },
  dismiss: (source) =>
    set((state) => (!source || state.request?.source === source ? { request: null } : state)),
}));
