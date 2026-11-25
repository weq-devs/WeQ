/** 常驻账号列表，已保存账号可通过右键菜单移除。 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Database, Laptop, Smartphone, Trash2 } from 'lucide-react';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { QqAvatar } from '../../components/QqAvatar';
import { TimeLabel } from '../../components/TimeLabel';
import { formatConversationTimestamp } from '../../lib/conversationTime';
import type { UiAccount } from './types';
import '../../styles/startup-account.css';
import { accountSource } from './AccountSelector.shared';

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
  const [menu, setMenu] = useState<{ acc: UiAccount; x: number; y: number } | null>(null);
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
          const canRemove = Boolean(onDeleteAccount && acc.configId);
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
                aria-haspopup={canRemove ? 'menu' : undefined}
                aria-expanded={canRemove ? menu?.acc.key === acc.key : undefined}
                data-weq-touch-context={canRemove ? '' : undefined}
                title={`${acc.name} · ${acc.uin}${acc.sourceDir ? `\n${acc.sourceDir}` : ''}`}
                onClick={() => onSelect(acc)}
                onContextMenu={
                  canRemove && !disabled
                    ? (event) => {
                        event.preventDefault();
                        event.currentTarget.focus({ preventScroll: true });
                        setMenu({ acc, x: event.clientX, y: event.clientY });
                      }
                    : undefined
                }
                onKeyDown={
                  canRemove && !disabled
                    ? (event) => {
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                          return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu({ acc, x: rect.left, y: rect.bottom });
                      }
                    : undefined
                }
              >
                <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={40} />
                <span className="weq-account-info">
                  <strong>{acc.name}</strong>
                  <span className="weq-account-identity">
                    <span className="weq-number weq-number-inherit">{acc.uin}</span>
                    <span>
                      <Icon size={12} aria-hidden />
                      {accountSource(acc)}
                    </span>
                  </span>
                  {acc.sourceDir && <span className="weq-account-path">{acc.sourceDir}</span>}
                  {lastOpened && (
                    <span className="weq-account-time">
                      上次打开{' '}
                      <TimeLabel value={openedAt} precision="millisecond">
                        {lastOpened}
                      </TimeLabel>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {menu && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="账号操作"
          compact
          onClose={close}
          actions={[
            {
              label: '移除此账号',
              icon: <Trash2 size={14} aria-hidden />,
              danger: 'outline',
              action: () => onDeleteAccount?.(menu.acc),
            },
          ]}
        />
      )}
    </>
  );
}
