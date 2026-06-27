/**
 * 应用锁状态（内存态，不持久化）。
 *
 * 锁由用户主动触发——左栏「手动上锁」按钮，或设置的「空闲自动上锁」计时
 * 到点。两者都只是把 `locked` 置 true；AppLockOverlay 消费该状态渲染锁屏，
 * 解锁强制走系统认证（Windows Hello / Touch ID），无绕过入口。
 *
 * 不持久化是有意的：重启后落在首页（bootstrap），本就需要重新进入账号，
 * 不存在「带锁启动」的状态。
 */

import { create } from 'zustand';

interface AppLockState {
  locked: boolean;
  lock(): void;
  unlock(): void;
}

export const useAppLock = create<AppLockState>((set) => ({
  locked: false,
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
}));
