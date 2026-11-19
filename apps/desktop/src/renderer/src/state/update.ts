import { create } from 'zustand';

interface UpdateState {
  packsAvailable: boolean;
  setPacksAvailable: (available: boolean) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  packsAvailable: false,
  setPacksAvailable: (packsAvailable) => set({ packsAvailable }),
}));
