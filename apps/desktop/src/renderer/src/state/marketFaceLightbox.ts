import { create } from 'zustand';

interface MarketFaceLightboxStore {
  packId: string | null;
  activeHash: string;
  anchor: HTMLElement | null;
  open(packId: string, activeHash?: string, anchor?: HTMLElement): void;
  close(): void;
}

export const useMarketFaceLightbox = create<MarketFaceLightboxStore>((set) => ({
  packId: null,
  activeHash: '',
  anchor: null,
  open(packId, activeHash = '', anchor) {
    if (!packId) return;
    set({ packId, activeHash, anchor: anchor ?? null });
  },
  close() {
    set({ packId: null, activeHash: '', anchor: null });
  },
}));

/** 打开整包浮层；再次点击同包其他消息时更新锚点与高亮。 */
export function openMarketFaceLightbox(
  packId: string,
  activeHash?: string,
  anchor?: HTMLElement,
): void {
  useMarketFaceLightbox.getState().open(packId, activeHash, anchor);
}
