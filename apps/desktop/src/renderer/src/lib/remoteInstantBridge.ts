export interface InstantTarget {
  scope: string;
  id: string;
  anchor?: string;
}

export type InstantSnapshot = {
  scope: string | null;
  chats?: {
    id: string;
    title: string;
    expiresAt: number;
    rows: { id: string; text: string; mine: boolean }[];
  }[];
};

declare global {
  interface Window {
    weqRemoteInstantSnapshot?: InstantSnapshot;
    weqRemoteInstantSupport?: boolean;
    weqRemoteInstantVerified?: boolean;
    weqRemoteOpenCachedChat?: (target: InstantTarget) => Promise<boolean>;
  }
}

export function instantNativeNotify(): (() => void) | undefined {
  const shell = window as Window & {
    webkit?: { messageHandlers?: { weqShell?: { postMessage: (value: string) => void } } };
    weqRemoteLinks?: { instantChanged?: () => void };
  };
  if (self !== top || !navigator.userAgent.includes('WeQRemote')) return;
  const android = shell.weqRemoteLinks;
  if (android?.instantChanged) return () => android.instantChanged?.();
  const ios = shell.webkit?.messageHandlers?.weqShell;
  if (ios && shell.weqRemoteInstantSupport) return () => ios.postMessage('instantChanged');
}

export function clearRemoteInstant(): void {
  const notify = instantNativeNotify();
  if (!notify || window.weqRemoteInstantSnapshot?.scope === null) return;
  window.weqRemoteInstantSnapshot = { scope: null, chats: [] };
  notify();
}

export function reportVerifiedRemoteChat(): void {
  if (typeof window === 'undefined' || window.weqRemoteInstantVerified || !instantNativeNotify())
    return;
  window.weqRemoteInstantVerified = true;
  const shell = window as Window & {
    webkit?: { messageHandlers?: { weqShell?: { postMessage: (value: string) => void } } };
    weqRemoteLinks?: { instantVerified?: () => void };
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (shell.weqRemoteLinks?.instantVerified) shell.weqRemoteLinks.instantVerified();
      else shell.webkit?.messageHandlers?.weqShell?.postMessage('instantVerified');
    });
  });
}
