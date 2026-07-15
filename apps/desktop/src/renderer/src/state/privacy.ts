/**
 * 隐私模式（全局视觉开关，持久化）。
 *
 * 开启后由一个 `html[data-privacy]` 根属性驱动 styles/privacy.css：把头像 /
 * 昵称 / 会话预览 / 消息气泡等敏感元素整屏 blur，hover 临时看清。主要用途是
 * 截图 / 录屏时遮挡隐私——遮罩是 DOM 上的 filter，webContents.capturePage()
 * 会如实截到糊后的效果，故截图天然与本开关联动。
 *
 * 约定：所有「跨 im-template 的全局视觉开关」只写在 WeQ 侧（一个根属性 + 一段
 * 桥接 CSS 挂钩模板的稳定 class），模板文件零改动。隐私是这个约定的第一个试点。
 */

import { create } from 'zustand';

const STORAGE_KEY = 'weq.privacy-mode';

type PrivacyState = {
  enabled: boolean;
  set: (enabled: boolean) => void;
  toggle: () => void;
  hydrate: () => void;
};

/** 把状态落到根属性 + localStorage。SSR/测试无 document 时安全跳过。 */
function apply(enabled: boolean): void {
  try {
    document.documentElement.toggleAttribute('data-privacy', enabled);
  } catch {}
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {}
}

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const usePrivacyStore = create<PrivacyState>((set, get) => ({
  enabled: false,
  set: (enabled) => {
    apply(enabled);
    set({ enabled });
  },
  toggle: () => {
    get().set(!get().enabled);
  },
  hydrate: () => {
    const enabled = read();
    apply(enabled);
    set({ enabled });
  },
}));
