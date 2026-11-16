import { create } from 'zustand';
import { useAppLock } from './lock';

export interface CaptureWindowRequest {
  source: string;
  uin: string;
  tab?: 'tcp' | 'udp';
}

interface CaptureWindowState {
  request: CaptureWindowRequest | null;
  open: (source: string, uin?: string, tab?: 'tcp' | 'udp') => void;
  dismiss: (source?: string) => void;
}

export const useCaptureWindow = create<CaptureWindowState>((set) => ({
  request: null,
  open: (source, uin = '', tab) => {
    if (source && !useAppLock.getState().locked) set({ request: { source, uin, tab } });
  },
  dismiss: (source) =>
    set((state) => (!source || state.request?.source === source ? { request: null } : state)),
}));
