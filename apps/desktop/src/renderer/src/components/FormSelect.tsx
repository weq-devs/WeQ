import { Check, ChevronDown } from 'lucide-react';
import {
  Children,
  type ChangeEventHandler,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  isValidElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useMobileBack } from '../hooks/useMobileNavigation';
import { useClosingContent } from '../hooks/useClosingContent';
import { useOverlayLayer } from '../lib/overlayStack';
import { surfaceMotionTiming } from '../lib/surfaceMotion';
import { useTabActive } from './RetainedTabs.shared';
import '../styles/form-select.css';

type Option = {
  value: string;
  label: string;
  detail?: string;
  title?: string;
  disabled?: boolean;
  placeholder?: boolean;
};

type OptionGroup = { label?: string; options: Option[] };

function optionText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? optionText(child.props.children)
        : typeof child === 'string' || typeof child === 'number'
          ? String(child)
          : '',
    )
    .join('');
}

function readOptions(children: ReactNode) {
  const groups: OptionGroup[] = [];
  let current: OptionGroup | undefined;
  function visit(nodes: ReactNode, group?: OptionGroup, disabled = false) {
    Children.forEach(nodes, (node) => {
      if (!isValidElement<ComponentProps<'option'> & { 'data-placeholder'?: boolean }>(node))
        return;
      const props = node.props;
      if (node.type === 'optgroup') {
        const next: OptionGroup = { label: props.label, options: [] };
        visit(props.children, next, props.disabled);
        if (next.options.length) groups.push(next);
        current = undefined;
      } else if (node.type === 'option') {
        if (!group && !current) {
          current = { options: [] };
          groups.push(current);
        }
        const target = group ?? current;
        const text = optionText(props.children).replace(/\s+/g, ' ').trim();
        target?.options.push({
          value: String(props.value ?? text),
          label: props.label ?? text,
          title: props.title,
          disabled: disabled || props.disabled,
          placeholder: props['data-placeholder'],
        });
      } else visit(props.children, group, disabled);
    });
  }
  visit(children);
  return groups;
}

function positionList(trigger: HTMLElement, list: HTMLElement) {
  const view = trigger.ownerDocument.defaultView;
  if (!view) return;
  const rect = trigger.getBoundingClientRect();
  const viewport = view.visualViewport;
  const inset = 8;
  const gap = 4;
  const leftEdge = (viewport?.offsetLeft ?? 0) + inset;
  const topEdge = (viewport?.offsetTop ?? 0) + inset;
  const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? view.innerWidth) - inset;
  const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? view.innerHeight) - inset;
  const width = Math.min(Math.max(rect.width, 156), rightEdge - leftEdge);
  const left = view.getComputedStyle(trigger).direction === 'rtl' ? rect.right - width : rect.left;
  const below = bottomEdge - rect.bottom - gap;
  const above = rect.top - topEdge - gap;
  const height = Math.min(list.scrollHeight + 4, 288);
  const flip = below < height && above > below;
  Object.assign(list.style, {
    width: `${width}px`,
    left: `${Math.min(Math.max(left, leftEdge), rightEdge - width)}px`,
    top: flip ? 'auto' : `${Math.max(topEdge, rect.bottom + gap)}px`,
    bottom: flip ? `${view.innerHeight - Math.min(bottomEdge, rect.top - gap)}px` : 'auto',
    maxHeight: `${Math.max(0, Math.min(288, flip ? above : below))}px`,
  });
}

function useOptionPopup<T extends HTMLElement>(options: Option[], enabled: boolean) {
  const id = useId();
  const trigger = useRef<T>(null);
  const list = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const available = enabled && options.length > 0;
  const open = expanded && available;
  const visible = useClosingContent(
    open ? true : null,
    available ? id : undefined,
    surfaceMotionTiming.exit,
  );
  const layer = useOverlayLayer(open);
  const close = useCallback(() => setExpanded(false), []);
  const reveal = useCallback((index = -1) => {
    setActive(index);
    setExpanded(true);
  }, []);
  useMobileBack(open, close, 110, () => list.current);

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const menu = list.current;
    const document = anchor?.ownerDocument;
    const view = document?.defaultView;
    if (!open || !anchor || !menu || !document || !view) return;
    menu.showPopover?.();
    positionList(anchor, menu);
    const update = (event: Event) => {
      if (event.target !== menu) positionList(anchor, menu);
    };
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().some((target) => target === anchor || target === menu)) close();
    };
    const focus = (event: FocusEvent) => {
      if (event.target !== anchor && !menu.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focus);
    view.addEventListener('scroll', update, true);
    view.addEventListener('resize', update);
    view.visualViewport?.addEventListener('resize', update);
    view.visualViewport?.addEventListener('scroll', update);
    return () => {
      // 定位和关闭监听立即结束，顶层浮层随节点卸载一并移除。
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focus);
      view.removeEventListener('scroll', update, true);
      view.removeEventListener('resize', update);
      view.visualViewport?.removeEventListener('resize', update);
      view.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const menu = list.current;
    const option = menu?.ownerDocument.getElementById(`${id}-${active}`);
    if (!menu || !option) return;
    const bounds = menu.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) menu.scrollTop += row.top - bounds.top;
    if (row.bottom > bounds.bottom) menu.scrollTop += row.bottom - bounds.bottom;
  }, [active, id, open]);

  function move(direction: 1 | -1, from = active) {
    const next = indexFrom(from, direction);
    if (next !== -1) setActive(next);
  }

  function indexFrom(from: number, direction: 1 | -1) {
    for (let index = from + direction; index >= 0 && index < options.length; index += direction) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }

  return {
    id,
    list,
    trigger,
    layer,
    open,
    visible,
    active,
    close,
    reveal,
    move,
    setActive,
    first: () => indexFrom(-1, 1),
    last: () => indexFrom(options.length, -1),
    aria: {
      role: 'combobox',
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-activedescendant': open && options[active] ? `${id}-${active}` : undefined,
    } as const,
  };
}

function OptionList({
  popup,
  groups,
  selected,
  onChoose,
  label,
}: {
  popup: ReturnType<typeof useOptionPopup<HTMLElement>>;
  groups: OptionGroup[];
  selected: string;
  onChoose: (index: number) => void;
  label: string;
}) {
  const anchor = popup.trigger.current;
  if (!popup.visible || !anchor) return null;
  const host =
    anchor.closest(
      '[data-field-popup-host], [role="dialog"], .weq-dialog-layer, .weq-overlay-layer, .weq-window-layer',
    ) ?? anchor.ownerDocument.body;
  let offset = 0;
  return createPortal(
    <div
      ref={popup.list}
      id={popup.id}
      className="weq-field-options"
      data-weq-escape-surface=""
      data-search-keep-open="true"
      popover="manual"
      role="listbox"
      aria-label={label}
      inert={!popup.open}
      aria-hidden={!popup.open || undefined}
      style={{ zIndex: popup.layer }}
    >
      {groups.map((group) => {
        const start = offset;
        offset += group.options.length;
        return (
          <div key={start} role={group.label ? 'group' : 'presentation'} aria-label={group.label}>
            {group.label && (
              <div className="weq-field-option-group" aria-hidden="true">
                {group.label}
              </div>
            )}
            {group.options.map((option, position) => {
              const index = start + position;
              const isSelected = !option.placeholder && option.value === selected;
              return (
                <div
                  key={index}
                  id={`${popup.id}-${index}`}
                  data-value={option.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  className="weq-field-option"
                  data-active={index === popup.active || undefined}
                  title={option.title}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={(event) => {
                    if (event.pointerType === 'mouse' && !option.disabled && popup.active !== index)
                      popup.setActive(index);
                  }}
                  onClick={() => {
                    if (!option.disabled) onChoose(index);
                  }}
                >
                  <span>
                    {option.label}
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  {isSelected && <Check size={14} aria-hidden />}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>,
    host,
  );
}

type FormSelectProps = Omit<
  ComponentProps<'button'>,
  'type' | 'value' | 'onChange' | 'defaultValue' | 'ref'
> & {
  value?: string | number;
  defaultValue?: string | number;
  required?: boolean;
  triggerLabel?: ReactNode;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  ref?: Ref<HTMLButtonElement>;
};

export function FormSelect({
  children,
  value,
  defaultValue,
  disabled,
  onChange,
  required,
  name,
  form,
  className,
  triggerLabel,
  ref,
  ...props
}: FormSelectProps) {
  const native = useRef<HTMLSelectElement>(null);
  const groups = readOptions(children);
  const options = groups.flatMap((group) => group.options);
  const [local, setLocal] = useState(defaultValue);
  const [invalid, setInvalid] = useState(false);
  const requested = value ?? local;
  const match = options.findIndex((option) => option.value === String(requested));
  const selected =
    match >= 0
      ? match
      : Math.max(
          0,
          options.findIndex((option) => !option.disabled),
        );
  const selectedOption = options[selected];
  const tabActive = useTabActive();
  const enabled = tabActive && !disabled;
  const popup = useOptionPopup<HTMLButtonElement>(options, enabled);
  const typeahead = useRef({ text: '', time: 0 });

  useLayoutEffect(() => {
    if (!enabled) popup.close();
  }, [enabled, popup.close]);

  function show() {
    const trigger = popup.trigger.current;
    if (trigger && !trigger.matches(':disabled')) {
      trigger.focus({ preventScroll: true });
      popup.reveal(selectedOption?.disabled ? popup.first() : selected);
    }
  }

  function choose(index: number) {
    const option = options[index];
    const field = native.current;
    popup.close();
    if (!field || field.matches(':disabled') || !option || option.disabled) return;
    popup.trigger.current?.focus({ preventScroll: true });
    setInvalid(false);
    if (field.value === option.value) return;
    if (value === undefined) setLocal(option.value);
    field.value = option.value;
    const view = field.ownerDocument.defaultView;
    if (view) field.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const { key } = event;
    if (key === 'Tab') {
      popup.close();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (popup.open) popup.move(key === 'ArrowDown' ? 1 : -1);
      else show();
    } else if (popup.open && (key === 'Home' || key === 'End')) {
      popup.setActive(key === 'Home' ? popup.first() : popup.last());
    } else if (popup.open && key === 'Escape') {
      popup.close();
    } else if (popup.open && (key === 'Enter' || key === ' ')) {
      if (!event.repeat) choose(popup.active);
    } else if (
      key.length === 1 &&
      key !== ' ' &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const now = Date.now();
      const previous = now - typeahead.current.time < 600 ? typeahead.current.text : '';
      const typed = key.toLocaleLowerCase();
      const query = previous === typed ? typed : previous + typed;
      typeahead.current = { text: query, time: now };
      const start = popup.open ? popup.active : selected;
      const offset = query.length > 1 ? 0 : 1;
      for (let step = 0; step < options.length; step++) {
        const index = (Math.max(0, start) + offset + step) % options.length;
        const option = options[index];
        if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(query)) {
          popup.reveal(index);
          break;
        }
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <>
      <button
        {...props}
        {...popup.aria}
        ref={(node) => {
          popup.trigger.current = node;
          if (typeof ref === 'function') return ref(node);
          if (ref) ref.current = node;
        }}
        type="button"
        className={`weq-select-trigger${className ? ` ${className}` : ''}`}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={invalid || props['aria-invalid']}
        data-value={selectedOption?.value}
        data-placeholder={selectedOption?.placeholder || undefined}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          props.onClick?.(event);
          if (event.defaultPrevented) return;
          if (popup.open) popup.close();
          else show();
        }}
      >
        <span className="weq-select-value">{triggerLabel ?? selectedOption?.label}</span>
        <ChevronDown className="weq-select-arrow" size={14} aria-hidden />
      </button>
      <select
        ref={native}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: 'none' }}
        name={name}
        form={form}
        value={selectedOption?.value ?? ''}
        disabled={disabled}
        required={required}
        onChange={onChange}
        onInvalid={(event) => {
          event.preventDefault();
          setInvalid(true);
          popup.trigger.current?.focus();
          show();
        }}
      >
        {children}
      </select>
      <OptionList
        popup={popup}
        groups={groups}
        selected={selectedOption?.value ?? ''}
        label={props['aria-label'] ?? props.title ?? '选项'}
        onChoose={choose}
      />
    </>
  );
}

export function FormSuggestions({
  options: suggestions,
  value,
  onValueChange,
  onSelectSuggestion = onValueChange,
  ...props
}: Omit<ComponentProps<'input'>, 'onChange' | 'value' | 'ref' | 'list'> & {
  options: { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
  onSelectSuggestion?: (value: string) => void;
}) {
  const query = value.trim().toLocaleLowerCase();
  const options = suggestions
    .filter((item) => `${item.value} ${item.label}`.toLocaleLowerCase().includes(query))
    .map((item) => ({
      value: item.value,
      label: item.label || item.value,
      detail: item.label ? item.value : undefined,
    }));
  const tabActive = useTabActive();
  const enabled = tabActive && !props.disabled;
  const popup = useOptionPopup<HTMLInputElement>(options, enabled);

  useLayoutEffect(() => {
    if (!enabled) popup.close();
  }, [enabled, popup.close]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    popup.trigger.current?.focus({ preventScroll: true });
    onSelectSuggestion(option.value);
    popup.close();
  }

  return (
    <>
      <input
        {...props}
        {...popup.aria}
        ref={popup.trigger}
        value={value}
        aria-autocomplete="list"
        onFocus={(event) => {
          props.onFocus?.(event);
          popup.reveal();
        }}
        onClick={(event) => {
          props.onClick?.(event);
          if (!popup.open) popup.reveal();
        }}
        onChange={(event) => {
          onValueChange(event.target.value);
          popup.reveal();
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
            return;
          if (event.key === 'Tab') {
            popup.close();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!options.length) return;
            if (popup.open && popup.active >= 0) popup.move(event.key === 'ArrowDown' ? 1 : -1);
            else popup.reveal(event.key === 'ArrowDown' ? popup.first() : popup.last());
          } else if (popup.open && event.key === 'Escape') popup.close();
          else if (popup.open && popup.active >= 0 && event.key === 'Enter') choose(popup.active);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <OptionList
        popup={popup}
        groups={[{ options }]}
        selected={value}
        label={props['aria-label'] ?? '建议'}
        onChoose={choose}
      />
    </>
  );
}
