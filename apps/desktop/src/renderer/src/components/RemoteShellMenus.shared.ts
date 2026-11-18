import { useEffect, useState } from 'react';

declare global {
  interface Window {
    weqRemoteShell?: { openMenu: () => void; connectionFailed?: () => void };
    weqMobileNavigation?: { back: () => boolean };
  }
}

export function useRemoteShellAvailable() {
  const [available, setAvailable] = useState(() => Boolean(window.weqRemoteShell));
  useEffect(() => {
    const ready = () => setAvailable(Boolean(window.weqRemoteShell));
    window.addEventListener('weq-remote-shell-ready', ready);
    ready();
    return () => window.removeEventListener('weq-remote-shell-ready', ready);
  }, []);
  return available;
}
