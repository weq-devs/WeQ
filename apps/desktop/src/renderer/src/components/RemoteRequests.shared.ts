import { create } from 'zustand';

export const useRemotePairingReview = create<{ id: string | null }>(() => ({ id: null }));
