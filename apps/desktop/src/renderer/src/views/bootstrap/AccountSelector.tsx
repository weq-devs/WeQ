/**
 * Centered big-avatar account header with a click-to-open dropdown selector.
 *
 * Header (vertical, centered): large avatar on top, bold nickname (or bold uin
 * fallback) below, thin uin under it. A "切换账号" pill is the ONLY clickable
 * trigger; clicking opens a scrollable list (avatar + nickname/uin rows). The
 * 菜单复用公共锚定浮层，列表可滚动，底部「登录新的账号」始终可达。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, Database, Smartphone, Trash2 } from 'lucide-react';
import { OverlayLayer } from '../../components/OverlayLayer';
import { QqAvatar } from '../../components/QqAvatar';
import type { UiAccount } from './types';
import '../../styles/startup-account.css';

export function AccountSelector({
  accounts,
  selected,
  onSelect,
  onDeleteAccount,
  footer,
}: {
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  onDeleteAccount?: (acc: UiAccount) => void;
  footer?: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const multiple = accounts.length > 1 || !!footer;

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ acc: UiAccount; anchor: HTMLElement } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const close = useCallback(() => {
    setCtxMenu(null);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    // 保留窗口失焦关闭，避免 Electron 拖拽区吞掉指针事件后菜单滞留。
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  return (
    <div className="weq-acct">
      <span className="weq-static-backup-avatar-wrap">
        <QqAvatar
          uin={selected?.uin}
          url={selected?.avatarUrl}
          size={140}
          className="weq-acct-avatar"
        />
        {selected?.static && (
          <span
            className="weq-static-badge is-lg"
            title={selected.mobile ? 'Android 手机备份账号' : '静态离线账号'}
            aria-label={selected.mobile ? 'Android 手机备份账号' : '静态离线账号'}
          >
            {selected.mobile ? (
              <Smartphone size={13} strokeWidth={2.2} aria-hidden />
            ) : (
              <Database size={13} strokeWidth={2.2} aria-hidden />
            )}
          </span>
        )}
      </span>

      <div className="weq-acct-id">
        <div
          className={selected?.hasName ? 'weq-acct-name' : 'weq-acct-name weq-acct-name-strong'}
          title={selected?.name}
        >
          {selected?.name ?? '未选择账号'}
        </div>
        {selected?.hasName && <div className="weq-acct-uin">{selected.uin}</div>}
      </div>

      {multiple && (
        <div className="weq-acct-switchwrap">
          <button
            ref={triggerRef}
            type="button"
            className={`weq-acct-switch ${open ? 'is-open' : ''}`}
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            切换账号
            <ChevronDown size={14} strokeWidth={2} aria-hidden />
          </button>

          {open && (
            <OverlayLayer
              presentation="popover"
              anchor={triggerRef.current}
              className="weq-startup-account-layer"
              onClose={close}
            >
              <div className="weq-acct-pop" role="menu" aria-label="切换账号">
                <div className="weq-acct-list">
                  {accounts.map((acc) => {
                    const active = acc.key === selected?.key;
                    const canDelete = onDeleteAccount && acc.configId;
                    return (
                      <button
                        type="button"
                        key={acc.key}
                        title={acc.name}
                        className={`weq-acct-row ${active ? 'is-active' : ''}`}
                        onClick={() => {
                          onSelect(acc);
                          close();
                        }}
                        onContextMenu={
                          canDelete
                            ? (e) => {
                                e.preventDefault();
                                setCtxMenu({ acc, anchor: e.currentTarget });
                              }
                            : undefined
                        }
                      >
                        <span className="weq-acct-row-avatar-wrap">
                          <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={38} />
                          {acc.static && (
                            <span
                              className="weq-static-badge"
                              title={acc.mobile ? 'Android 手机备份账号' : '静态离线账号'}
                              aria-label={acc.mobile ? 'Android 手机备份账号' : '静态离线账号'}
                            >
                              {acc.mobile ? (
                                <Smartphone size={9} strokeWidth={2.2} aria-hidden />
                              ) : (
                                <Database size={9} strokeWidth={2.2} aria-hidden />
                              )}
                            </span>
                          )}
                        </span>
                        <div className="weq-acct-row-id">
                          <div
                            className={
                              acc.hasName
                                ? 'weq-acct-row-name'
                                : 'weq-acct-row-name weq-acct-name-strong'
                            }
                          >
                            {acc.name}
                          </div>
                          <div className="weq-acct-row-uin">{acc.uin}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {footer && <div className="weq-acct-foot">{footer}</div>}
              </div>
            </OverlayLayer>
          )}
        </div>
      )}
      {ctxMenu && (
        <OverlayLayer
          presentation="popover"
          anchor={ctxMenu.anchor}
          className="weq-startup-account-context-layer"
          onClose={closeCtxMenu}
        >
          <div
            className="weq-acct-ctx-menu"
            role="menu"
            aria-label="账号操作"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                onDeleteAccount?.(ctxMenu.acc);
                close();
              }}
            >
              <Trash2 size={15} />
              <span>删除账号</span>
            </button>
          </div>
        </OverlayLayer>
      )}
    </div>
  );
}
