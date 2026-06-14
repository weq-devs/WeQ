/**
 * 顶层视图状态。
 *
 * 当前只有首页和主界面两个活动视图，同时保存跨视图复用的数据。
 */

import { create } from 'zustand';

export type View = 'bootstrap' | 'main';

interface ViewState {
  view: View;
  /** 打开账号后写入，用于驱动主界面。 */
  openedUin: string | null;
  /**
   * 用于推导每个账号 `nt_msg.db` 路径的 Tencent Files 根目录。
   * null 表示使用自动检测到的第一个目录；非 null 表示用户手动选择。
   */
  tencentFilesRoot: string | null;
  goTo(view: View): void;
  setOpenedUin(uin: string | null): void;
  setTencentFilesRoot(root: string | null): void;
}

export const useViewState = create<ViewState>((set) => ({
  view: 'bootstrap',
  openedUin: null,
  tencentFilesRoot: null,
  goTo: (view) => set({ view }),
  setOpenedUin: (openedUin) => set({ openedUin }),
  setTencentFilesRoot: (tencentFilesRoot) => set({ tencentFilesRoot }),
}));
