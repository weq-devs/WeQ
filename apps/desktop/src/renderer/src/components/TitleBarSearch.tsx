import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useOverlayLayer } from '../lib/overlayStack';
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
  const expanded = pinned || (!persistent && hovered && !suppressHover);
  const hasPanel = Boolean(results) || pinned;
  const layer = useOverlayLayer(expanded && hasPanel);

  useEffect(() => {
    if (pinned) input.current?.focus();
  }, [pinned]);

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
        if (event.key === 'Escape') {
          event.stopPropagation();
          setPinned(false);
          setSuppressHover(true);
          input.current?.blur();
        }
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
        aria-label="搜索全部内容"
        tabIndex={persistent || expanded ? 0 : -1}
        disabled={!persistent && !expanded}
        value={query}
        placeholder={persistent ? '搜索内容、功能与设置' : '搜索全部内容'}
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
            input.current?.focus();
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
                if (!(event.target instanceof Element) || !event.target.closest('[role="option"]'))
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
