/**
 * Big-avatar account header with a click-to-open dropdown selector.
 *
 * Header: large avatar, bold nickname (or bold uin fallback), uin below. When
 * more than one account exists a chevron appears; clicking opens a height-
 * capped, scrollable list (avatar + nickname/uin rows, hairline dividers,
 * hover animation). The optional footer slot hosts "登录新的账号" (new flow).
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { QqAvatar } from '../../components/QqAvatar';
import type { UiAccount } from './types';

export function AccountSelector({
  accounts,
  selected,
  onSelect,
  footer,
}: {
  accounts: UiAccount[];
  selected: UiAccount | null;
  onSelect: (acc: UiAccount) => void;
  footer?: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const multiple = accounts.length > 1 || !!footer;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="weq-acct" ref={ref}>
      <button
        type="button"
        className="weq-acct-head"
        onClick={() => multiple && setOpen((o) => !o)}
        data-interactive={multiple}
        aria-haspopup={multiple}
        aria-expanded={open}
      >
        <QqAvatar uin={selected?.uin} url={selected?.avatarUrl} size={72} className="weq-acct-avatar" />
        <div className="weq-acct-id">
          <div className={selected?.hasName ? 'weq-acct-name' : 'weq-acct-name weq-acct-name-strong'}>
            {selected?.name ?? '未选择账号'}
          </div>
          {selected?.hasName && <div className="weq-acct-uin">{selected.uin}</div>}
        </div>
        {multiple && (
          <ChevronDown
            className={`weq-acct-chevron ${open ? 'is-open' : ''}`}
            size={18}
            strokeWidth={1.9}
            aria-hidden
          />
        )}
      </button>

      {open && (
        <div className="weq-acct-pop weq-anim-pop">
          <div className="weq-acct-list">
            {accounts.map((acc) => {
              const active = acc.key === selected?.key;
              return (
                <button
                  type="button"
                  key={acc.key}
                  className={`weq-acct-row ${active ? 'is-active' : ''}`}
                  onClick={() => {
                    onSelect(acc);
                    setOpen(false);
                  }}
                >
                  <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={38} />
                  <div className="weq-acct-row-id">
                    <div className={acc.hasName ? 'weq-acct-row-name' : 'weq-acct-row-name weq-acct-name-strong'}>
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
      )}
    </div>
  );
}
