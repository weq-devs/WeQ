/** 常驻账号列表；配置操作既能点按，也保留右键入口。 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Check, Database, Laptop, MoreHorizontal, Smartphone, Trash2 } from 'lucide-react';
import { OverlayLayer } from '../../components/OverlayLayer';
import { QqAvatar } from '../../components/QqAvatar';
import { formatConversationTimestamp } from '../../lib/conversationTime';
import type { UiAccount } from './types';
import '../../styles/startup-account.css';

export function accountSource(account: UiAccount): string {
  return account.mobile ? '手机备份' : account.static ? '本地备份' : '本机 QQ';
}

export function AccountSelector({
  accounts,
  selected,
  onSelect,
  onDeleteAccount,
  disabled = false,
}: {
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  onDeleteAccount?: (acc: UiAccount) => void;
  disabled?: boolean;
}): ReactElement {
  const [menu, setMenu] = useState<{ acc: UiAccount; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [menu, close]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  return (
    <>
      <ul className="weq-account-list" aria-label="账号列表">
        {accounts.map((acc) => {
          const Icon = acc.mobile ? Smartphone : acc.static ? Database : Laptop;
          const openedAt = new Date(acc.lastLoginAt ?? 0);
          const lastOpened = Number.isFinite(openedAt.getTime())
            ? formatConversationTimestamp(openedAt.toISOString())
            : '';
          return (
            <li
              key={acc.key}
              className={`weq-account-item${selected?.key === acc.key ? ' is-selected' : ''}`}
            >
              <button
                type="button"
                className="weq-account-select"
                disabled={disabled}
                aria-pressed={selected?.key === acc.key}
                title={`${acc.name} · ${acc.uin}${acc.sourceDir ? `\n${acc.sourceDir}` : ''}`}
                onClick={() => onSelect(acc)}
                onContextMenu={
                  onDeleteAccount && acc.configId && !disabled
                    ? (event) => {
                        event.preventDefault();
                        setMenu({ acc, anchor: event.currentTarget });
                      }
                    : undefined
                }
              >
                <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={40} />
                <span className="weq-account-info">
                  <strong>{acc.name}</strong>
                  <span className="weq-account-identity">
                    {acc.uin}
                    <span>
                      <Icon size={12} aria-hidden />
                      {accountSource(acc)}
                    </span>
                  </span>
                  {acc.sourceDir && <span className="weq-account-path">{acc.sourceDir}</span>}
                  {lastOpened && <span className="weq-account-time">上次打开 {lastOpened}</span>}
                </span>
                {selected?.key === acc.key && (
                  <Check className="weq-account-check" size={16} aria-hidden />
                )}
              </button>
              {onDeleteAccount && acc.configId && (
                <button
                  type="button"
                  className="weq-account-more weq-icon-button"
                  title={`账号操作：${acc.name}`}
                  aria-label={`账号操作：${acc.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.acc.key === acc.key}
                  disabled={disabled}
                  onClick={(event) =>
                    setMenu(menu?.acc.key === acc.key ? null : { acc, anchor: event.currentTarget })
                  }
                >
                  <MoreHorizontal size={17} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {menu && (
        <OverlayLayer
          presentation="popover"
          anchor={menu.anchor}
          className="weq-startup-account-context-layer"
          onClose={close}
        >
          <div className="weq-acct-ctx-menu" role="menu" aria-label="账号操作">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onDeleteAccount?.(menu.acc);
                close();
              }}
            >
              <Trash2 size={15} aria-hidden />
              <span>移除已保存配置</span>
            </button>
          </div>
        </OverlayLayer>
      )}
    </>
  );
}
