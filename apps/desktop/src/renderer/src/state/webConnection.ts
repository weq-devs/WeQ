import { create } from 'zustand';

type WebConnection = {
  status: 'connecting' | 'connected' | 'reconnecting';
  connectedBefore: boolean;
  recovery: number;
  connected: () => void;
  disconnected: () => void;
};

export const useWebConnection = create<WebConnection>((set) => ({
  status: 'connecting',
  connectedBefore: false,
  recovery: 0,
  connected: () =>
    set((state) => ({
      status: 'connected',
      connectedBefore: true,
      recovery:
        state.connectedBefore && state.status !== 'connected' ? state.recovery + 1 : state.recovery,
    })),
  disconnected: () =>
    set((state) => ({ status: state.connectedBefore ? 'reconnecting' : 'connecting' })),
}));
