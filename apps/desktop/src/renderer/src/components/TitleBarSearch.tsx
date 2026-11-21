import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { hasActiveModal, useOverlayLayer } from '../lib/overlayStack';
import { IS_WEB } from '../lib/target.shared';
import { RESTORE_SEARCH_EVENT } from './search/searchPosition.shared';
import { Search, X } from 'lucide-react';

export function TitleBarSearch({
  query,
  onQueryChange,
  onSearchFocus,
  results,
  persistent = false,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSearchFocus?: () => void;
  results?: ReactNode;
  persistent?: boolean;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const forceInputFocus = useRef(false);
  const hadResults = useRef(false);
  const expanded = pinned || (!persistent && hovered && !suppressHover);
  const hasPanel = Boolean(results) || pinned;
  const layer = useOverlayLayer(expanded && hasPanel);

  useEffect(() => {
    if (pinned && (forceInputFocus.current || !panel.current?.contains(document.activeElement)))
      input.current?.focus();
    forceInputFocus.current = false;
  }, [pinned]);

  useEffect(() => {
    if (hadResults.current && !results) {
      setPinned(false);
      setSuppressHover(true);
    }
    hadResults.current = Boolean(results);
  }, [results]);

  const openKeyboardSearch = useEffectEvent((focusInput: boolean) => {
    if (!root.current?.getClientRects().length || !root.current.offsetWidth) return false;
    const active = document.activeElement;
    if (
      (focusInput || !returnFocus.current) &&
      active instanceof HTMLElement &&
      !root.current.contains(active) &&
      !panel.current?.contains(active)
    )
      returnFocus.current = active;
    forceInputFocus.current = focusInput;
    setSuppressHover(false);
    setPinned(true);
    onSearchFocus?.();
    if (pinned && focusInput) input.current?.focus();
    return true;
  });

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.key.toLowerCase() !== 'k' ||
        event.metaKey === event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        hasActiveModal() ||
        !openKeyboardSearch(true)
      )
        return;
      event.preventDefault();
    };
    const onRestore = () => openKeyboardSearch(false);
    if (!IS_WEB) window.addEventListener('keydown', onShortcut);
    window.addEventListener(RESTORE_SEARCH_EVENT, onRestore);
    return () => {
      if (!IS_WEB) window.removeEventListener('keydown', onShortcut);
      window.removeEventListener(RESTORE_SEARCH_EVENT, onRestore);
    };
  }, []);

  useLayoutEffect(() => {
    if (!expanded) return;
    const update = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(720, Math.max(0, window.innerWidth - 16));
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: rect.bottom + 6,
        width,
        maxHeight: Math.max(
          0,
          (window.visualViewport?.height ?? window.innerHeight) +
            (window.visualViewport?.offsetTop ?? 0) -
            rect.bottom -
            14,
        ),
        overflowY: 'auto',
      });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        root.current?.contains(event.target) ||
        panel.current?.contains(event.target)
      )
        return;
      setPinned(false);
      setHovered(false);
      setSuppressHover(true);
      input.current?.blur();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);

  return (
    <div
      ref={root}
      className={`weq-titlebar-search${persistent || expanded ? ' is-expanded' : ''}${persistent ? ' is-persistent' : ''}`}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        setHovered(true);
        setSuppressHover(false);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        setHovered(false);
        setSuppressHover(false);
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        )
          return;
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          const back = panel.current?.querySelector<HTMLButtonElement>('[data-search-back]');
          if (back) {
            back.click();
            return;
          }
          setPinned(false);
          setSuppressHover(true);
          input.current?.blur();
          const previous = returnFocus.current;
          returnFocus.current = null;
          if (previous?.isConnected && previous !== document.body)
            previous.focus({ preventScroll: true });
          else root.current?.querySelector('button')?.focus();
          return;
        }
        if (
          !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        const target = event.target;
        if (
          !(target instanceof HTMLElement) ||
          (target !== input.current &&
            !target.matches('[data-search-row-input], button[data-search-hit-key]'))
        )
          return;
        if (event.key === 'Enter' && target instanceof HTMLButtonElement) return;
        const rows = [
          ...(panel.current?.querySelectorAll<HTMLButtonElement>(
            'button[data-search-hit-key]:not(:disabled)',
          ) ?? []),
        ];
        if (!rows.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Enter') {
          if (!event.repeat) rows[0]?.click();
          return;
        }
        const current = rows.indexOf(target as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown' ? current + 1 : current === -1 ? rows.length - 1 : current - 1;
        if (next < 0 || next >= rows.length)
          (
            panel.current?.querySelector<HTMLInputElement>('[data-search-row-input]') ??
            input.current
          )?.focus({ preventScroll: true });
        else rows[next]?.focus();
      }}
    >
      <button
        type="button"
        title={pinned ? '收起全局搜索' : '全局搜索'}
        aria-label="全局搜索"
        aria-expanded={expanded}
        aria-pressed={pinned}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setSuppressHover(true);
            input.current?.blur();
          } else {
            forceInputFocus.current = true;
            setPinned(true);
            setSuppressHover(false);
            onSearchFocus?.();
          }
        }}
      >
        <Search size={18} />
      </button>
      <input
        ref={input}
        type="search"
        aria-label="搜索内容、功能与设置"
        hidden={!persistent && !expanded}
        value={query}
        placeholder="搜索内容、功能与设置"
        onChange={(event) => onQueryChange(event.target.value)}
        onFocus={() => {
          setPinned(true);
          onSearchFocus?.();
        }}
      />
      {(persistent || expanded) && query ? (
        <button
          type="button"
          className="weq-titlebar-search-clear"
          title="清空搜索"
          aria-label="清空搜索"
          onClick={() => {
            onQueryChange('');
            if (expanded && hasPanel) input.current?.focus();
          }}
        >
          <X size={20} aria-hidden />
        </button>
      ) : null}
      {expanded && hasPanel && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panel}
              className="weq-titlebar-search-results"
              style={{ ...position, zIndex: layer }}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') setHovered(true);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') setHovered(false);
              }}
              onClick={(event) => {
                if (
                  !(event.target instanceof Element) ||
                  !event.target.closest('[role="option"]') ||
                  event.target.closest('[data-search-keep-open="true"]')
                )
                  return;
                setPinned(false);
                setHovered(false);
                setSuppressHover(true);
              }}
            >
              {results}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
