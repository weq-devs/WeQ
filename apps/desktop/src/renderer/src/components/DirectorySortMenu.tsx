import { Check, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useOverlayAnchor } from '../lib/overlayAnchor.shared';
import { OVERLAY_BASE_LAYER, useOverlayLayer } from '../lib/overlayStack';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { useExitMotion } from '../hooks/useExitMotion';
import { SegmentedControl } from './SegmentedControl';
import '../styles/form-select.css';
import '../styles/contact-directory-order.css';

const pinyin = ['拼音 A–Z', '拼音 Z–A'] as const;
const number = ['小的在前', '大的在前'] as const;
const count = ['少的在前', '多的在前'] as const;
const score = ['低的在前', '高的在前'] as const;
const time = ['早的在前', '晚的在前'] as const;

const directions: Record<string, readonly [string, string]> = {
  displayName: pinyin,
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
  memberLevel: score,
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
  lastSpeakAt: time,
};

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

export function DirectoryMenu({
  label,
  children,
  active = true,
  disabled = false,
  highlighted = false,
  className = '',
  title,
  triggerIcon,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  className?: string;
  title?: string;
  triggerIcon?: ReactNode;
}) {
  const panelId = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const dismiss = useCallback(() => {
    close();
    anchor?.focus({ preventScroll: true });
  }, [anchor, close]);
  const open = active && !disabled && anchor !== null;
  const { position } = useOverlayAnchor(surface, open, true, anchor ?? undefined);
  const layer = useOverlayLayer(open);
  const present = useExitMotion(surface, open);
  const lastPlacement = useRef<{ document: Document; position: CSSProperties | undefined }>(null);
  useLayoutEffect(() => {
    if (open && anchor) lastPlacement.current = { document: anchor.ownerDocument, position };
  }, [open, anchor, position]);
  const portalDocument = anchor?.ownerDocument ?? lastPlacement.current?.document;
  useSurfaceEscapeDismissal(panel, dismiss, open);

  useLayoutEffect(() => {
    if (!open) {
      close();
      return;
    }
    panel.current?.querySelector<HTMLElement>('button:not([tabindex="-1"])')?.focus({
      preventScroll: true,
    });
  }, [open, close]);

  useEffect(() => {
    if (!open || !anchor) return;
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
  }, [open, anchor, close]);

  return (
    <>
      <button
        type="button"
        className={`${triggerIcon ? '' : 'weq-set-btn '}weq-directory-menu-button ${className}`.trim()}
        aria-label={triggerIcon ? label : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-active={highlighted ? '' : undefined}
        disabled={disabled || !active}
        title={title}
        onClick={(event) => {
          const button = event.currentTarget;
          button.focus({ preventScroll: true });
          setAnchor((current) => (current ? null : button));
        }}
      >
        {triggerIcon ?? (
          <>
            {label}
            <ChevronDown className="weq-select-arrow" size={14} aria-hidden />
          </>
        )}
      </button>
      {present && active && !disabled && portalDocument
        ? createPortal(
            <div
              ref={surface}
              className="weq-directory-menu-layer"
              data-weq-escape-surface=""
              data-weq-surface-motion="fade"
              data-closing={!open || undefined}
              aria-hidden={!open || undefined}
              inert={!open}
              style={{
                ...(open ? position : lastPlacement.current?.position),
                zIndex: open ? layer : OVERLAY_BASE_LAYER,
              }}
            >
              <section
                id={panelId}
                ref={panel}
                role="dialog"
                aria-label={label}
                className="weq-directory-menu"
              >
                {children}
              </section>
            </div>,
            portalDocument.body,
          )
        : null}
    </>
  );
}

export function DirectorySortMenu({
  options,
  sort,
  descending,
  onSort,
  onDirection,
  children,
  active,
  className,
  triggerIcon,
  highlighted,
}: {
  options: Record<string, string>;
  sort: string;
  descending: boolean;
  onSort: (field: string) => void;
  onDirection: (descending: boolean) => void;
  children?: ReactNode;
  active?: boolean;
  className?: string;
  triggerIcon?: ReactNode;
  highlighted?: boolean;
}) {
  const [ascendingLabel, descendingLabel] = directions[sort] ?? ['升序', '降序'];
  return (
    <DirectoryMenu
      label="排序"
      active={active}
      className={className}
      title={triggerIcon ? `排序 · ${options[sort]}` : options[sort]}
      triggerIcon={triggerIcon}
      highlighted={highlighted}
    >
      <SortOptions options={options} value={sort} onChange={onSort} />
      <SegmentedControl
        label="排序方向"
        value={descending ? 'descending' : 'ascending'}
        options={[
          { value: 'ascending', label: ascendingLabel },
          { value: 'descending', label: descendingLabel },
        ]}
        onChange={(direction) => onDirection(direction === 'descending')}
      />
      {children}
    </DirectoryMenu>
  );
}
