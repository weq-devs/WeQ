import { Check, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { useContactDirectoryOrder } from '../hooks/useContactDirectoryOrder';
import type { FriendSort, GroupSort } from '../lib/contactListOrder';
import { useOverlayAnchor } from '../lib/overlayAnchor.shared';
import { useOverlayLayer } from '../lib/overlayStack';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { ContactCacheRefreshDialog } from './ContactRefreshButton';
import { FormSelect } from './FormSelect';
import { SegmentedControl } from './SegmentedControl';
import '../styles/contact-directory-order.css';

const pinyin = ['拼音 A–Z', '拼音 Z–A'] as const;
const number = ['小的在前', '大的在前'] as const;
const count = ['少的在前', '多的在前'] as const;
const score = ['低的在前', '高的在前'] as const;
const time = ['早的在前', '晚的在前'] as const;

const directions: Record<FriendSort | GroupSort, readonly [string, string]> = {
  remark: pinyin,
  nick: pinyin,
  name: pinyin,
  uin: number,
  groupCode: number,
  maxSeq: number,
  age: ['年轻的在前', '年长的在前'],
  birthday: ['年初的在前', '年末的在前'],
  intimacy: score,
  likeCount: count,
  level: score,
  commonFriends: count,
  commonGroups: count,
  energy: score,
  affinity: score,
  memberCount: count,
  activityScore: score,
  friendCount: count,
  addedAt: time,
  sigUpdateTime: time,
  lastMessageAt: time,
  createTime: time,
  lastSpokeAt: time,
  joinedAt: time,
};

const menuLabels = { filter: '筛选', sort: '排序' };
type Menu = keyof typeof menuLabels;

function SortOptions({
  options,
  value,
  onChange,
}: {
  options: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(value);
  useLayoutEffect(() => {
    const element = list.current;
    const selected = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (element && selected)
      element.scrollTop = Math.max(
        0,
        selected.offsetTop + selected.offsetHeight - element.clientHeight,
      );
  }, []);

  return (
    <div
      ref={list}
      className="weq-directory-sort-options"
      role="listbox"
      aria-label="排序依据"
      onKeyDown={(event) => {
        const { key } = event;
        if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        event.stopPropagation();
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next =
          key === 'Home'
            ? 0
            : key === 'End'
              ? buttons.length - 1
              : Math.max(0, Math.min(buttons.length - 1, index + (key === 'ArrowUp' ? -1 : 1)));
        buttons[next]?.focus();
      }}
    >
      {Object.entries(options).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="option"
          className="weq-field-option"
          aria-selected={value === id}
          data-value={id}
          data-active={value === id || undefined}
          tabIndex={focused === id ? 0 : -1}
          onFocus={() => setFocused(id)}
          onClick={() => {
            if (value !== id) onChange(id);
          }}
        >
          {label}
          {value === id && <Check size={14} aria-hidden />}
        </button>
      ))}
    </div>
  );
}

export function ContactDirectoryOrder({
  order,
  filters,
  filtersApplied = false,
  filtersDisabled = false,
  active = true,
}: {
  order: ReturnType<typeof useContactDirectoryOrder>;
  filters?: ReactNode;
  filtersApplied?: boolean;
  filtersDisabled?: boolean;
  active?: boolean;
}) {
  const panelId = useId();
  const [menu, setMenu] = useState<{ kind: Menu; anchor: HTMLButtonElement } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = active && menu !== null && (menu.kind !== 'filter' || !filtersDisabled);
  const { position } = useOverlayAnchor(surface, open, true, menu?.anchor);
  const layer = useOverlayLayer(open);
  useSurfaceEscapeDismissal(panel, close, open);

  useLayoutEffect(() => {
    if (!open) {
      close();
      return;
    }
    panel.current?.querySelector<HTMLElement>('button:not([tabindex="-1"])')?.focus({
      preventScroll: true,
    });
  }, [open, menu, close]);

  useEffect(() => {
    if (!open || !menu) return;
    const { anchor } = menu;
    const document = anchor.ownerDocument;
    const outside = (event: Event) => {
      const path = event.composedPath();
      if (panel.current && !path.includes(anchor) && !path.includes(panel.current)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [open, menu, close]);

  const { grouping, sort, descending } = order.preferences;
  const [ascendingLabel, descendingLabel] = directions[sort as keyof typeof directions] ?? [
    '升序',
    '降序',
  ];

  const trigger = (kind: Menu) => (
    <button
      type="button"
      className="weq-set-btn weq-directory-menu-button"
      aria-haspopup="dialog"
      aria-expanded={open && menu?.kind === kind}
      aria-controls={open && menu?.kind === kind ? panelId : undefined}
      data-active={kind === 'filter' && filtersApplied ? '' : undefined}
      disabled={kind === 'filter' && filtersDisabled}
      onClick={(event) => {
        const anchor = event.currentTarget;
        anchor.focus({ preventScroll: true });
        setMenu((current) => (current?.kind === kind ? null : { kind, anchor }));
      }}
    >
      {menuLabels[kind]}
      <ChevronDown className="weq-select-arrow" size={14} aria-hidden />
    </button>
  );

  return (
    <>
      <div className="weq-directory-order">
        <div className="weq-directory-order-buttons">
          {filters && trigger('filter')}
          <FormSelect
            className="weq-set-btn weq-directory-menu-button"
            aria-label="分组依据"
            triggerLabel="分组"
            disabled={!active}
            value={grouping}
            onChange={(event) => order.change({ grouping: event.target.value })}
          >
            {Object.entries(order.groupingOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </FormSelect>
          {trigger('sort')}
        </div>
        {order.error ? (
          <small role="alert">{order.error}</small>
        ) : order.progress?.status === 'running' ? (
          <small role="status">
            好友/群信息缓存更新中{' '}
            <span className="weq-number weq-number-inherit">{order.progress.done}</span>/
            <span className="weq-number weq-number-inherit">{order.progress.total}</span>
          </small>
        ) : order.progress?.status === 'paused' ? (
          <small role="status">好友/群信息缓存更新已暂停，等待 QQ 在线</small>
        ) : null}
      </div>
      {open &&
        menu &&
        createPortal(
          <div
            ref={surface}
            className="weq-directory-menu-layer"
            data-weq-escape-surface=""
            style={{ ...position, zIndex: layer }}
          >
            <section
              id={panelId}
              ref={panel}
              role="dialog"
              aria-label={menuLabels[menu.kind]}
              className="weq-directory-menu"
            >
              {menu.kind === 'filter' ? (
                filters
              ) : (
                <>
                  <SortOptions
                    options={order.sortOptions}
                    value={sort}
                    onChange={(sort) => order.change({ sort })}
                  />
                  <SegmentedControl
                    label="排序方向"
                    value={descending ? 'descending' : 'ascending'}
                    options={[
                      { value: 'ascending', label: ascendingLabel },
                      { value: 'descending', label: descendingLabel },
                    ]}
                    onChange={(direction) =>
                      order.change({ descending: direction === 'descending' })
                    }
                  />
                </>
              )}
            </section>
          </div>,
          menu.anchor.ownerDocument.body,
        )}
      {order.refreshRequest && (
        <ContactCacheRefreshDialog
          stale
          fields={order.refreshRequest.fields}
          onClose={order.closeRefresh}
        />
      )}
    </>
  );
}
