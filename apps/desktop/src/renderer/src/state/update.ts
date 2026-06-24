/**
 * 应用内更新提示状态。
 *
 * 后台启动检查 / 设置页检查发现新版本时置位，驱动左栏「设置」入口的红点。
 * 由 MainView 顶层订阅 `update.onEvent`（与 getState 兜底）写入。
 */

import { create } from 'zustand';

interface UpdateState {
  /** 是否存在可更新的新版本。 */
  available: boolean;
  /** 最新版本号（如 1.2.0），未知为 null。 */
  latest: string | null;
  setAvailable(latest: string): void;
  clear(): void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  available: false,
  latest: null,
  setAvailable: (latest) => set({ available: true, latest }),
  clear: () => set({ available: false, latest: null }),
}));
