import { useEffect, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import '../styles/remote-shell.css';

declare global {
  interface Window {
    weqRemoteShell?: { openMenu: () => void };
    weqMobileNavigation?: { back: () => boolean };
  }
}

function useRemoteShellAvailable() {
  const [available, setAvailable] = useState(() => Boolean(window.weqRemoteShell));
  useEffect(() => {
    const ready = () => setAvailable(Boolean(window.weqRemoteShell));
    window.addEventListener('weq-remote-shell-ready', ready);
    ready();
    return () => window.removeEventListener('weq-remote-shell-ready', ready);
  }, []);
  return available;
}

export function RemoteShellMenuItem({ onClose }: { onClose: () => void }) {
  const available = useRemoteShellAvailable();
  if (!available) return null;
  return (
    <button
      type="button"
      role="menuitem"
      className="has-separator"
      onClick={() => {
        onClose();
        window.weqRemoteShell?.openMenu();
      }}
    >
      <Ellipsis size={18} aria-hidden />
      <span>连接菜单</span>
    </button>
  );
}

/** 仅由手机主顶栏显式渲染，不向业务页面查找或注入按钮。 */
export function RemoteShellMenuButton() {
  const available = useRemoteShellAvailable();
  if (!available) return null;
  return (
    <button
      type="button"
      className="weq-remote-shell-menu icon-button"
      aria-label="连接菜单"
      title="连接菜单"
      onClick={() => window.weqRemoteShell?.openMenu()}
    >
      <Ellipsis size={22} aria-hidden />
    </button>
  );
}
