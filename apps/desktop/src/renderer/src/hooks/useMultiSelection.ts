import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { selectMessageIds, type SelectionModifiers } from '../lib/messageSelection';
import { hasActiveModal } from '../lib/overlayStack';
import '../styles/multi-selection.css';

let keyboardOwner: HTMLElement | null = null;
type SelectionCommand = Pick<
  KeyboardEvent<HTMLElement>,
  'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'preventDefault' | 'stopPropagation'
>;

/** 所有列表的范围以稳定身份为锚；键盘只作用于当前聚焦的选择组。 */
export function useMultiSelection<K extends string | number>({
  ids,
  selected,
  onChange,
  enabled = true,
  disabled: locked = false,
  normalClick = 'toggle',
  onStart,
  onExit,
  anchorRef,
}: {
  ids: readonly K[];
  selected: ReadonlySet<K>;
  onChange: (next: Set<K>) => void;
  enabled?: boolean;
  disabled?: boolean;
  normalClick?: 'toggle' | 'passthrough';
  onStart?: () => void;
  onExit?: () => void;
  anchorRef?: { current: string | null };
}) {
  const groupId = useId();
  const root = useRef<HTMLElement | null>(null);
  // 合并 ref 的宿主重渲染时会先传 null，再传回节点，不能因此丢掉键盘归属。
  const ownedBeforeRef = useRef(false);
  const setRoot = useCallback((element: HTMLElement | null) => {
    if (!element && keyboardOwner === root.current) {
      ownedBeforeRef.current = true;
      keyboardOwner = null;
    }
    root.current = element;
    if (element && ownedBeforeRef.current) {
      keyboardOwner = element;
      ownedBeforeRef.current = false;
    }
  }, []);
  const internalAnchor = useRef<string | null>(null);
  const anchor = anchorRef ?? internalAnchor;
  const current = useRef(selected);
  current.current = selected;
  const focusChoice = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const items = [...element.querySelectorAll<HTMLElement>('[data-weq-select-id]')].filter(
      (item) =>
        !item.hasAttribute('disabled') &&
        item.getAttribute('aria-disabled') !== 'true' &&
        item.closest('[data-weq-multi-group]') === element,
    );
    const visible = items.filter((item) => {
      const bounds = (item.closest('[data-weq-windowed-list]') ?? element).getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      return (
        rect.height > 0 &&
        rect.bottom > Math.max(0, bounds.top) &&
        rect.top < Math.min(window.innerHeight, bounds.bottom)
      );
    });
    const candidates = visible.length ? visible : items;
    const selectedKeys = new Set([...current.current].map(String));
    const choice =
      candidates.find((item) => selectedKeys.has(item.dataset.weqSelectId ?? '')) ??
      candidates[0] ??
      element;
    choice.focus({ preventScroll: true });
  }, []);
  const pointer = useRef<string | null>(null);
  const refocusAfterUpdate = useRef(false);
  useEffect(() => {
    if (!refocusAfterUpdate.current) return;
    refocusAfterUpdate.current = false;
    if (
      enabled &&
      !locked &&
      keyboardOwner === root.current &&
      root.current?.isConnected &&
      !root.current.closest('[hidden], [inert]') &&
      document.activeElement === document.body
    )
      focusChoice();
  });
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (
      enabled &&
      !locked &&
      !wasEnabled.current &&
      root.current &&
      !root.current.closest('[hidden], [inert]')
    ) {
      keyboardOwner = root.current;
      if (!root.current.contains(document.activeElement)) focusChoice();
    }
    wasEnabled.current = enabled;
  }, [enabled, locked, focusChoice]);
  const [focusRequest, setFocusRequest] = useState<{ id: string; revision: number } | null>(null);
  const keys = ids.map(String);
  const values = new Map(ids.map((id) => [String(id), id]));
  const update = (next: Set<string>) => {
    const mapped = new Set<K>();
    const previousValues = new Map([...current.current].map((id) => [String(id), id]));
    for (const key of next) {
      const value = values.get(key) ?? previousValues.get(key);
      if (value !== undefined) mapped.add(value);
    }
    current.current = mapped;
    refocusAfterUpdate.current = true;
    onChange(mapped);
  };
  const toggle = (id: K, modifiers: SelectionModifiers = {}) => {
    if (locked) return;
    const key = String(id);
    if (!keys.includes(key)) return;
    if (!enabled) onStart?.();
    update(
      selectMessageIds(
        new Set([...current.current].map(String)),
        keys,
        key,
        anchor.current,
        modifiers,
      ),
    );
    if (!modifiers.shiftKey || !anchor.current || !keys.includes(anchor.current))
      anchor.current = key;
  };
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => {
      const element = [
        ...(root.current?.querySelectorAll<HTMLElement>('[data-weq-select-id]') ?? []),
      ].find((item) => item.dataset.weqSelectId === focusRequest.id);
      element?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const modified = (event: SelectionModifiers) => event.ctrlKey || event.metaKey || event.shiftKey;
  const itemProps = (id: K, disabled = false) => ({
    'data-weq-select-id': String(id),
    tabIndex: disabled || locked ? -1 : 0,
    'aria-disabled': disabled || locked || undefined,
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      pointer.current = null;
      if (
        disabled ||
        locked ||
        event.currentTarget.closest('fieldset:disabled') ||
        event.button !== 0 ||
        !modified(event)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      pointer.current = String(id);
      toggle(id, event);
      event.currentTarget.focus();
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (disabled || locked || event.currentTarget.closest('fieldset:disabled')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const handledPointer = pointer.current === String(id);
      // checkbox 的 checked 会先原生切换；已处理的 pointer 尾随点击才需取消默认。
      if (!handledPointer && (!enabled || normalClick === 'passthrough') && !modified(event))
        return;
      if (
        !(event.target instanceof HTMLInputElement && event.target.type === 'checkbox') ||
        handledPointer
      )
        event.preventDefault();
      event.stopPropagation();
      if (!handledPointer) toggle(id, event);
      pointer.current = null;
      event.currentTarget.focus();
    },
    onContextMenuCapture: (event: MouseEvent<HTMLElement>) => {
      if (event.ctrlKey) event.preventDefault();
    },
  });
  const handleCommand = (event: SelectionCommand): boolean => {
    if (locked) return false;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      if (!enabled) onStart?.();
      if (!event.shiftKey) anchor.current ??= keys[0] ?? null;
      update(event.shiftKey ? new Set() : new Set([...current.current].map(String).concat(keys)));
      return true;
    }
    if (!enabled) return false;
    if (event.key === 'Escape') {
      if (!onExit && current.current.size === 0) return false;
      event.preventDefault();
      event.stopPropagation();
      if (onExit) onExit();
      else update(new Set());
      return true;
    }
    return false;
  };
  const latestCommand = useRef(handleCommand);
  latestCommand.current = handleCommand;
  useEffect(() => {
    if (!enabled || locked) return;
    const mounted = root.current;
    const listener = (event: globalThis.KeyboardEvent) => {
      const element = root.current;
      const target = event.target;
      if (
        !element?.isConnected ||
        keyboardOwner !== element ||
        event.defaultPrevented ||
        event.altKey ||
        element.closest('[hidden], [inert], fieldset:disabled') ||
        !(target instanceof HTMLElement)
      )
        return;
      if (
        target.closest('textarea, select, [contenteditable="true"], input:not([type="checkbox"])')
      )
        return;
      const ownDialog = element.closest('[role="dialog"]');
      if (target.closest('[role="dialog"]') !== ownDialog && hasActiveModal()) return;
      latestCommand.current(event);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      if (keyboardOwner === mounted) keyboardOwner = null;
    };
  }, [enabled, locked]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (locked) return;
    if (
      event.altKey ||
      !(event.target instanceof HTMLElement) ||
      event.target.closest('[hidden], [inert], fieldset:disabled')
    )
      return;
    if (event.target.closest('[data-weq-multi-group]') !== event.currentTarget) return;
    if (
      event.target.closest(
        'textarea, select, [contenteditable="true"], input:not([type="checkbox"])',
      )
    )
      return;
    const rangeKey = event.shiftKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
    const modifiedSpace = event.key === ' ' && (event.ctrlKey || event.metaKey || event.shiftKey);
    if (handleCommand(event) || (!enabled && !rangeKey && !modifiedSpace)) return;
    const key = event.target.closest<HTMLElement>('[data-weq-select-id]')?.dataset.weqSelectId;
    if (!key) return;
    const index = keys.indexOf(key);
    if (event.key === ' ' && values.has(key)) {
      event.preventDefault();
      event.stopPropagation();
      toggle(values.get(key)!, event);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? keys.length - 1
          : Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    const target = keys[next];
    if (!target) return;
    if (event.shiftKey) {
      anchor.current ??= key;
      toggle(values.get(target)!, event);
    }
    setFocusRequest((request) => ({
      id: target,
      revision: Math.max(Date.now(), (request?.revision ?? 0) + 1),
    }));
  };
  return {
    toggle,
    itemProps,
    focusRequest,
    rootProps: {
      'data-weq-multi-group': groupId,
      tabIndex: -1,
      ref: setRoot,
      onKeyDown,
      onFocusCapture: () => {
        keyboardOwner = root.current;
      },
      onPointerDownCapture: () => {
        keyboardOwner = root.current;
      },
    },
  };
}

export type MultiSelectionItemProps = ReturnType<ReturnType<typeof useMultiSelection>['itemProps']>;
