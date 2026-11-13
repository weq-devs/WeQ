import { useSyncExternalStore } from 'react';
import { IS_WEB } from './target';

/** 连接壳身份不随窗口大小、横竖屏或是否有鼠标而变化。 */
export function isRemoteClient(): boolean {
  return (
    IS_WEB &&
    typeof window !== 'undefined' &&
    (Boolean(window.weqRemoteShell) || /\bWeQRemote\b/.test(window.navigator.userAgent))
  );
}

function subscribe(notify: () => void) {
  window.addEventListener('weq-remote-shell-ready', notify);
  return () => window.removeEventListener('weq-remote-shell-ready', notify);
}

export function useRemoteClient(): boolean {
  return useSyncExternalStore(subscribe, isRemoteClient, () => false);
}
