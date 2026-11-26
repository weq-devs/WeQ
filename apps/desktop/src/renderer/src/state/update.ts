import { create } from 'zustand';

interface UpdateState {
  softwareAvailable: boolean;
  setSoftwareAvailable: (available: boolean) => void;
  packsAvailable: boolean;
  setPacksAvailable: (available: boolean) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  softwareAvailable: false,
  setSoftwareAvailable: (softwareAvailable) => set({ softwareAvailable }),
  packsAvailable: false,
  setPacksAvailable: (packsAvailable) => set({ packsAvailable }),
}));
