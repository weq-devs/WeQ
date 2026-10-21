import { create } from 'zustand';
import type { DbRepairAccountOption } from '../components/DbRepairPanel';

interface DbRepairWindowState {
  request: DbRepairAccountOption | null;
  open: (account: DbRepairAccountOption) => void;
  dismiss: () => void;
}

export const useDbRepairWindow = create<DbRepairWindowState>((set) => ({
  request: null,
  open: (account) => {
    if (account.uin) set({ request: { ...account } });
  },
  dismiss: () => set({ request: null }),
}));
