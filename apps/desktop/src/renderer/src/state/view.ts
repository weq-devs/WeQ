/**
 * 顶层视图状态。
 *
 * 两个活动视图：首页（密钥获取）与主界面。首页内部还有自己的阶段
 * （booting / home / select）与子页面（existing / new / backup），见下方字段。
 */

import { create } from 'zustand';

export type View = 'bootstrap' | 'main';

/** 启动探测后直接展示账号工作区；select 保留显式入口的路由状态。 */
export type HomeStage = 'booting' | 'home' | 'select';

/** 账号工作区：最近账号 / 添加账号 / 导入备份。 */
export type SelectMode = 'existing' | 'new' | 'backup';

interface ViewState {
  view: View;
  /** 打开账号后写入，用于驱动主界面。 */
  openedUin: string | null;
  /** 首页内部阶段。 */
  homeStage: HomeStage;
  /** 选择页当前模式。 */
  selectMode: SelectMode;
  goTo(view: View): void;
  setOpenedUin(uin: string | null): void;
  setHomeStage(stage: HomeStage): void;
  /** 进入选择页并指定模式。 */
  enterSelect(mode: SelectMode): void;
  /** 回到主页。 */
  backHome(): void;
}

export const useViewState = create<ViewState>((set) => ({
  view: 'bootstrap',
  openedUin: null,
  homeStage: 'booting',
  selectMode: 'existing',
  goTo: (view) => set({ view }),
  setOpenedUin: (openedUin) => set({ openedUin }),
  setHomeStage: (homeStage) => set({ homeStage }),
  enterSelect: (selectMode) => set({ selectMode, homeStage: 'select' }),
  backHome: () => set({ homeStage: 'home', selectMode: 'existing' }),
}));
