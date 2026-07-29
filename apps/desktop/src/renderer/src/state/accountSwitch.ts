/**
 * 切换账号的过渡状态。
 *
 * 必须是全局的：切号流程写在 RailAccountFooter 里，而它自己就在 MainView 内部，
 * `App.tsx` 用 `key={openedUin}` 重挂载 MainView 时它会跟着卸载——组件内的
 * useState 在卸载后 setState 是空操作，进度根本推不动。
 *
 * 激活期间 App 直接渲染载入页、**不渲染 MainView**。这样顺带解决了原来的双重
 * 挂载：以前 `setOpenedUin(null)` → `setOpenedUin(新)` 会让 MainView 挂载两次，
 * 中间那次发生在后端账号已关闭的窗口里，8 个查询全打在空账号上（然后被第二次
 * purge 丢掉）。现在整个过渡期间它压根不挂载。
 */

import { create } from 'zustand';
import type { WarmupProgress } from '../lib/accountWarmup';

interface AccountSwitchState {
  /** 真时 App 渲染载入页而非 MainView。 */
  active: boolean;
  /** 转圈阶段的文案（打开账号中，此时还没有百分比）。 */
  hint: string;
  /** 预热进度；null 表示还在转圈阶段。 */
  progress: WarmupProgress | null;
  begin(hint: string): void;
  setHint(hint: string): void;
  setProgress(progress: WarmupProgress | null): void;
  end(): void;
}

export const useAccountSwitch = create<AccountSwitchState>((set) => ({
  active: false,
  hint: '正在切换账号…',
  progress: null,
  begin: (hint) => set({ active: true, hint, progress: null }),
  setHint: (hint) => set({ hint }),
  setProgress: (progress) => set({ progress }),
  end: () => set({ active: false, progress: null }),
}));
