/**
 * 隐私模式（全局视觉开关，持久化）。
 *
 * 开启后由一个 `html[data-privacy]` 根属性驱动 styles/privacy.css：把头像 /
 * 昵称 / 会话预览 / 私人正文等字段 blur，保留装扮、统计和操作，不在悬停时揭示。主要用途是
 * 截图 / 录屏时遮挡隐私——遮罩是 DOM 上的 filter，webContents.capturePage()
 * 会如实截到糊后的效果，故截图天然与本开关联动。
 *
 * 通用字段复用稳定 class；混排身份与元数据时，用 data-privacy-sensitive 精确标记。
 */

import { create } from 'zustand';
import { WEQ_MENU_CAPTURE_PRIVACY_KEY as CAPTURE_PRIVACY_STORAGE_KEY } from '@weq/service/backup-client';
export { CAPTURE_PRIVACY_STORAGE_KEY };

export const PRIVACY_STORAGE_KEY = 'weq.privacy-mode';

type PrivacyState = {
  enabled: boolean;
  effective: boolean;
  capturePrivacy: boolean;
  setCapturePrivacy: (enabled: boolean) => void;
  beginTemporary: () => () => void;
  set: (enabled: boolean) => void;
  toggle: () => void;
  hydrate: () => void;
};

/** 临时覆盖只改绘制属性，不写永久偏好。 */
function apply(enabled: boolean): void {
  try {
    document.documentElement.toggleAttribute('data-privacy', enabled);
  } catch {}
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function persist(key: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(key, enabled ? '1' : '0');
  } catch {}
}

export const usePrivacyStore = create<PrivacyState>((set, get) => {
  const owners = new Set<symbol>();
  const sync = (enabled = get().enabled) => {
    const effective = enabled || owners.size > 0;
    apply(effective);
    set({ enabled, effective });
  };
  return {
    enabled: false,
    effective: false,
    capturePrivacy: false,
    setCapturePrivacy: (capturePrivacy) => {
      persist(CAPTURE_PRIVACY_STORAGE_KEY, capturePrivacy);
      set({ capturePrivacy });
    },
    beginTemporary: () => {
      const owner = Symbol('capture-privacy');
      owners.add(owner);
      sync();
      return () => {
        if (owners.delete(owner)) sync();
      };
    },
    set: (enabled) => {
      persist(PRIVACY_STORAGE_KEY, enabled);
      sync(enabled);
    },
    toggle: () => {
      get().set(!get().enabled);
    },
    hydrate: () => {
      sync(read(PRIVACY_STORAGE_KEY));
      set({ capturePrivacy: read(CAPTURE_PRIVACY_STORAGE_KEY) });
    },
  };
});
