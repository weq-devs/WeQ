import { create } from 'zustand';
import type { Restriction } from '../lib/restrictedMode';

export interface AuthorizationRequest {
  kind: 'password' | 'ptrace';
  token: number;
  title: string;
  message: string;
}

interface RestrictedModeState {
  reasons: Restriction[];
  requests: AuthorizationRequest[];
  open: boolean;
  setReasons(reasons: Restriction[]): void;
  setOpen(open: boolean): void;
  request(request: AuthorizationRequest): void;
  remove(kind: AuthorizationRequest['kind'], token: number): void;
}

export const useRestrictedMode = create<RestrictedModeState>((set) => ({
  reasons: [],
  requests: [],
  open: false,
  setReasons: (reasons) =>
    set((state) =>
      state.reasons.length === reasons.length &&
      state.reasons.every(
        (reason, index) =>
          reason.code === reasons[index]?.code &&
          reason.title === reasons[index]?.title &&
          reason.guidance === reasons[index]?.guidance,
      )
        ? state
        : { reasons },
    ),
  setOpen: (open) => set({ open }),
  request: (request) =>
    set((state) => ({
      requests: [...state.requests.filter((item) => item.kind !== request.kind), request],
    })),
  remove: (kind, token) =>
    set((state) => ({
      requests: state.requests.filter((item) => item.kind !== kind || item.token !== token),
    })),
}));
