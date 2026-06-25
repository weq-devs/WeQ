/**
 * Centered big-avatar account header with a click-to-open dropdown selector.
 *
 * Header (vertical, centered): large avatar on top, bold nickname (or bold uin
 * fallback) below, thin uin under it. A "切换账号" pill is the ONLY clickable
 * trigger; clicking opens a scrollable list (avatar + nickname/uin rows). The
 * popover is anchored to the pill and flips up/down with a measured max-height
 * so it never spills past the window — the footer ("登录新的账号") stays
 * reachable regardless of where the pill sits in the column.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, Database } from 'lucide-react';
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState<{ dir: 'down' | 'up'; maxHeight: number }>({
    dir: 'down',
    maxHeight: 320,
  });
  const multiple = accounts.length > 1 || !!footer;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    // Electron `-webkit-app-region: drag` regions swallow mouse events before
    // they reach JS, so a mousedown on the title bar never fires `onDown`.
    // The window blurs the moment a drag region is pressed — use that as a
    // fallback close signal so the popover doesn't get stranded open.
    function onBlur(): void {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  // Pick the side with more room and cap the height so the footer never falls
  // outside the window. Re-measures on resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    function measure(): void {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const gap = 10;
      const margin = 14;
      const below = window.innerHeight - r.bottom - gap - margin;
      const above = r.top - gap - margin;
      const dir: 'down' | 'up' = below >= 240 || below >= above ? 'down' : 'up';
      const maxHeight = Math.max(168, Math.floor(dir === 'down' ? below : above));
      setPlacement({ dir, maxHeight });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  return (
    <div className="weq-acct" ref={ref}>
      <span className="weq-static-backup-avatar-wrap">
        <QqAvatar uin={selected?.uin} url={selected?.avatarUrl} size={140} className="weq-acct-avatar" />
        {selected?.static && (
          <span className="weq-static-badge is-lg" title="静态离线账号" aria-label="静态离线账号">
            <Database size={13} strokeWidth={2.2} aria-hidden />
          </span>
        )}
      </span>

      <div className="weq-acct-id">
        <div className={selected?.hasName ? 'weq-acct-name' : 'weq-acct-name weq-acct-name-strong'}>
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
            aria-haspopup="true"
            aria-expanded={open}
          >
            切换账号
            <ChevronDown size={14} strokeWidth={2} aria-hidden />
          </button>

          {open && (
            <div
              className={`weq-acct-pop weq-anim-popc ${placement.dir === 'up' ? 'is-up' : ''}`}
              style={{ maxHeight: placement.maxHeight }}
            >
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
                      <span className="weq-acct-row-avatar-wrap">
                        <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={38} />
                        {acc.static && (
                          <span className="weq-static-badge" title="静态离线账号" aria-label="静态离线账号">
                            <Database size={9} strokeWidth={2.2} aria-hidden />
                          </span>
                        )}
                      </span>
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
      )}
    </div>
  );
}
