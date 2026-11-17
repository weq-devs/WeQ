import { create } from 'zustand';

export interface RedBagDetailTarget {
  msgId: string;
  kind: 'c2c' | 'group';
  conv: string;
  /** 自定义封面 id（存在时优先于通用封面）。 */
  skinId?: number;
  /** 发红包者头像用的 uin（拿不到时回退领取人 / 占位）。 */
  senderUin?: string;
}

// ---- store ----------------------------------------------------------------

interface RedBagStore {
  target: RedBagDetailTarget | null;
  open(target: RedBagDetailTarget): void;
  close(): void;
}

export const useRedBagStore = create<RedBagStore>((set) => ({
  target: null,
  open(target) {
    set({ target });
  },
  close() {
    set({ target: null });
  },
}));

/** 命令式打开红包灯箱（QqWallet 点击时调用）。 */
export function openRedBagDetail(target: RedBagDetailTarget): void {
  useRedBagStore.getState().open(target);
}
