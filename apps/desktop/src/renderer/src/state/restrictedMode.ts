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
  reasonSource: string | null;
  requests: AuthorizationRequest[];
  open: boolean;
  enteringSince: number | null;
  enteringManually: boolean;
  setReasons(reasons: Restriction[], source?: string | null): void;
  setOpen(open: boolean): void;
  beginEntering(manual?: boolean): void;
  endEntering(): void;
  request(request: AuthorizationRequest): void;
  remove(kind: AuthorizationRequest['kind'], token: number): void;
}

export const useRestrictedMode = create<RestrictedModeState>((set) => ({
  reasons: [],
  reasonSource: null,
  requests: [],
  open: false,
  enteringSince: null,
  enteringManually: false,
  setReasons: (reasons, reasonSource = null) =>
    set((state) =>
      state.reasonSource === reasonSource &&
      state.reasons.length === reasons.length &&
      state.reasons.every(
        (reason, index) =>
          reason.code === reasons[index]?.code &&
          reason.title === reasons[index]?.title &&
          reason.guidance === reasons[index]?.guidance,
      )
        ? state
        : { reasons, reasonSource },
    ),
  setOpen: (open) => set({ open }),
  beginEntering: (manual = true) => set({ enteringSince: Date.now(), enteringManually: manual }),
  endEntering: () => set({ enteringSince: null, enteringManually: false }),
  request: (request) =>
    set((state) => ({
      requests: [...state.requests.filter((item) => item.kind !== request.kind), request],
    })),
  remove: (kind, token) =>
    set((state) => ({
      requests: state.requests.filter((item) => item.kind !== kind || item.token !== token),
    })),
}));
