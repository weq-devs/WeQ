/**
 * 「修复完成 → 回首页」这件事的待办状态。
 *
 * 为什么需要一个 store，而不是面板自己的 useState：数据库修复面板挂在妙妙工具弹窗
 * 里，**弹窗一关面板就没了**。而替换数据库那一步已经把当前账号在主进程里关掉了
 * （见 `<DbRepairReturnOverlay>` 的注释），此时渲染层还停在主界面上，是坏的（有会话
 * 列表、没头像、点不开消息）。如果倒计时随面板一起消失，用户关掉弹窗就被困在那个界面
 * 里，且不知道该怎么办。
 *
 * 所以倒计时放在这里，由挂在 `App` 上的 `<DbRepairReturnOverlay>` 渲染 —— 它和
 * BootstrapView / MainView 同层级，弹窗关掉、视图切换都不影响它。
 *
 * 注意 `warn` 那一档：替换阶段失败（账号已关、库没换成）与修复成功一样需要回首页，
 * 只是措辞不同 —— 两句话都不是建议，而是"不回首页就看不见正确数据"。
 */

import { create } from 'zustand';

interface DbRepairReturnState {
  /** null = 没有待执行的返回。 */
  pending: { title: string; detail: string; seconds: number; tone: DbRepairReturnTone } | null;
  /** 安排一次「N 秒后回首页」。 */
  arm(input: {
    title: string;
    detail: string;
    seconds?: number;
    /**
     * `ok` = 修好了；`warn` = 替换没成功（例如替换前复核发现 QQ 又把库打开了），
     * 但账号已经被关掉了，同样得回首页重新打开。
     */
    tone?: DbRepairReturnTone;
  }): void;
  /** 用户点了「立即返回」或倒计时走完 —— 撤掉这条待办。 */
  disarm(): void;
}

export type DbRepairReturnTone = 'ok' | 'warn';

/** 默认等几秒。短到不用盯着，长到够看清结果是"修复成功"。 */
export const DB_REPAIR_RETURN_SECONDS = 8;

export const useDbRepairReturn = create<DbRepairReturnState>((set) => ({
  pending: null,
  arm: ({ title, detail, seconds = DB_REPAIR_RETURN_SECONDS, tone = 'ok' }) =>
    set({ pending: { title, detail, seconds, tone } }),
  disarm: () => set({ pending: null }),
}));
