/**
 * IconPicker —— 带图标/分组/次要信息的轻量下拉（替代原生 select）。
 *
 * 菜单用 portal 挂到 body + fixed 定位，避免被 .weq-modal / 滚动容器裁切；
 * 视口底部放不下时自动向上弹。z-index 走 useOverlayLayer，永远盖在弹窗之上。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useOverlayLayer } from '../../lib/overlayStack';
import '../../styles/icon-picker.css';

export interface IconPickerOption {
  value: string;
  label: string;
  /** 次要信息（文件大小等），靠右显示。 */
  detail?: string;
  /** 每项图标（日志/数据库/issue·pr 各自提供）。 */
  icon?: ReactNode;
  /** 分组标题；不传则平铺。 */
  group?: string;
}

const GAP = 6;

export function IconPicker({
  options,
  value,
  onChange,
  triggerIcon,
  placeholder = '请选择',
  ariaLabel,
  width,
  maxHeight = 240,
  disabled,
}: {
  options: IconPickerOption[];
  value: string;
  onChange: (value: string) => void;
  /** 触发器左侧图标（可随当前选中项变化）。 */
  triggerIcon?: ReactNode;
  placeholder?: string;
  ariaLabel?: string;
  /** 触发器宽度；不传则按内容自适应。 */
  width?: number | string;
  /** 菜单最大高度（超出滚动）。 */
  maxHeight?: number;
  disabled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 本次打开是否已做过「向上弹」校正（防止重复 setPos 死循环）。 */
  const adjustedRef = useRef(false);
  const layer = useOverlayLayer(open);

  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);

  // 点击外部 / Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const toggle = (): void => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    adjustedRef.current = false;
    setPos({ top: r.bottom + GAP, left: r.left, width: r.width });
    setOpen(true);
  };

  // 打开后若超出视口底部，向上弹（只校正一次）。
  useLayoutEffect(() => {
    if (!open || !pos || adjustedRef.current) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      setPos((p) => (p ? { ...p, top: Math.max(8, window.innerHeight - rect.height - 8) } : p));
    }
    adjustedRef.current = true;
  }, [open, pos]);

  // 按 group 分组（假定 options 已按分组排好序）。
  const groups: Array<{ label: string | null; items: IconPickerOption[] }> = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (!last || last.label !== (o.group ?? null))
      groups.push({ label: o.group ?? null, items: [o] });
    else last.items.push(o);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="weq-picker-trigger"
        style={width !== undefined ? { width } : undefined}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={selected ? selected.label : placeholder}
        onClick={toggle}
      >
        {triggerIcon ? <span className="weq-picker-trigger-icon">{triggerIcon}</span> : null}
        <span className="weq-picker-trigger-label">{selected ? selected.label : placeholder}</span>
        <ChevronDown
          size={14}
          className={`weq-picker-chevron${open ? ' is-open' : ''}`}
          aria-hidden
        />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="weq-picker-menu"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: pos.width,
                maxHeight,
                zIndex: layer,
              }}
            >
              {groups.map((g) => (
                <div key={g.label ?? '__plain'} className="weq-picker-group">
                  {g.label ? <div className="weq-picker-group-label">{g.label}</div> : null}
                  {g.items.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={o.value === value}
                      className={`weq-picker-option${o.value === value ? ' is-on' : ''}`}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      {o.icon ? <span className="weq-picker-option-icon">{o.icon}</span> : null}
                      <span className="weq-picker-option-label">{o.label}</span>
                      {o.detail ? (
                        <span className="weq-picker-option-detail">{o.detail}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
