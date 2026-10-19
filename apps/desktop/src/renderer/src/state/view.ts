/**
 * 顶层视图状态。
 *
 * 两个活动视图：首页（密钥获取）与主界面。首页内部还有自己的阶段
 * （booting / home / select）与模式（existing / new），见下方字段。
 */

import { create } from 'zustand';

export type View = 'bootstrap' | 'main';

/** 首页阶段：启动自动进入探测 → 主页（logo+两按钮）→ 账号/密钥选择页。 */
export type HomeStage = 'booting' | 'home' | 'select';

/** 选择页模式：现有配置 / 新的开始。 */
export type SelectMode = 'existing' | 'new';

interface ViewState {
  view: View;
  /** 打开账号后写入，用于驱动主界面。 */
  openedUin: string | null;
  /** 首页内部阶段。 */
  homeStage: HomeStage;
  /** 选择页当前模式。 */
  selectMode: SelectMode;
  managedAutoEnterConfigId: string | null;
  goTo(view: View): void;
  setOpenedUin(uin: string | null): void;
  setHomeStage(stage: HomeStage): void;
  /** 进入选择页并指定模式。 */
  enterSelect(mode: SelectMode): void;
  enterManagedAuto(configId: string): void;
  consumeManagedAuto(): void;
  /** 回到主页。 */
  backHome(): void;
}

export const useViewState = create<ViewState>((set) => ({
  view: 'bootstrap',
  openedUin: null,
  homeStage: 'booting',
  selectMode: 'new',
  managedAutoEnterConfigId: null,
  goTo: (view) => set({ view, managedAutoEnterConfigId: null }),
  setOpenedUin: (openedUin) => set({ openedUin }),
  setHomeStage: (homeStage) =>
    set({ homeStage, ...(homeStage === 'home' ? { managedAutoEnterConfigId: null } : {}) }),
  enterSelect: (selectMode) =>
    set({ selectMode, homeStage: 'select', managedAutoEnterConfigId: null }),
  enterManagedAuto: (configId) =>
    set({ selectMode: 'existing', homeStage: 'select', managedAutoEnterConfigId: configId }),
  consumeManagedAuto: () => set({ managedAutoEnterConfigId: null }),
  backHome: () => set({ homeStage: 'home', managedAutoEnterConfigId: null }),
}));
