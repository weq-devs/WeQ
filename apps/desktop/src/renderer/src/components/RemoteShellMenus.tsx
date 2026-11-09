import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import '../styles/remote-shell.css';

declare global {
  interface Window {
    weqRemoteShell?: { openMenu: () => void };
    weqMobileNavigation?: { back: () => boolean };
  }
}

const HEADERS =
  'header, .weq-qzn-header, .weq-mail-topbar, .weq-collection-head, .weq-market-head, .weq-dress-head, .weq-wtools-pane-head';

export function RemoteShellMenuItem({ onClose }: { onClose: () => void }) {
  if (!window.weqRemoteShell || !window.matchMedia('(max-width: 760px)').matches) return null;
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

/** 将同一个壳入口放进已有页面栏；普通浏览器不安装观察器。 */
export function RemoteShellMenus({ root }: { root: RefObject<HTMLElement | null> }) {
  const [available, setAvailable] = useState(() => Boolean(window.weqRemoteShell));
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  useEffect(() => {
    const ready = () => setAvailable(Boolean(window.weqRemoteShell));
    window.addEventListener('weq-remote-shell-ready', ready);
    ready();
    return () => window.removeEventListener('weq-remote-shell-ready', ready);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!available || !element) return;
    const scan = () => {
      const next = [...element.querySelectorAll<HTMLElement>(HEADERS)]
        .filter((header) => {
          if (
            header.closest('article, .message-row, .weq-mobile-more') ||
            header.querySelector('[aria-label="更多会话操作"]')
          )
            return false;
          const page = header.closest('.weq-workspace-page, .chat-main');
          return (
            header.matches('.weq-mobile-header, .chat-header, .weq-mobile-settings-header') ||
            !header.matches('header') ||
            page?.querySelector('header') === header
          );
        })
        .map((header) => header.querySelector<HTMLElement>('.chat-actions') ?? header);
      setTargets((current) =>
        current.length === next.length && current.every((item, index) => item === next[index])
          ? current
          : next,
      );
    };
    scan();
    window.addEventListener('resize', scan);
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element && (node.matches(HEADERS) || node.querySelector(HEADERS)),
          ),
        )
      )
        scan();
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scan);
    };
  }, [available, root]);
  return targets.map((target, index) =>
    createPortal(
      <button
        type="button"
        className="weq-remote-shell-menu icon-button"
        aria-label="连接菜单"
        title="连接菜单"
        onClick={() => window.weqRemoteShell?.openMenu()}
      >
        <Ellipsis size={22} aria-hidden />
      </button>,
      target,
      String(index),
    ),
  );
}
