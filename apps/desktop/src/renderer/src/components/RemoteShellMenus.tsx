import { Ellipsis } from 'lucide-react';
import { useRemoteShellAvailable } from './RemoteShellMenus.shared';
import '../styles/remote-shell.css';

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
