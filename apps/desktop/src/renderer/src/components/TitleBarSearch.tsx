import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Search } from 'lucide-react';

export function TitleBarSearch({
  query,
  onQueryChange,
  onSearchFocus,
  results,
  onReturn,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSearchFocus?: () => void;
  results?: ReactNode;
  onReturn?: () => boolean;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  const expanded = pinned || (hovered && !suppressHover);

  useEffect(() => {
    if (pinned && !returning.current) input.current?.focus();
    returning.current = false;
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
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
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
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);

  return (
    <div
      ref={root}
      className={`weq-titlebar-search${expanded ? ' is-expanded' : ''}${onReturn ? ' has-return' : ''}`}
      onPointerEnter={() => {
        setHovered(true);
        setSuppressHover(false);
      }}
      onPointerLeave={() => {
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
      {onReturn ? (
        <button
          type="button"
          title="返回搜索结果"
          aria-label="返回搜索结果"
          onClick={() => {
            const expand = onReturn();
            returning.current = expand && !pinned;
            setPinned(expand);
            setHovered(false);
            setSuppressHover(true);
          }}
        >
          <ArrowLeft size={18} />
        </button>
      ) : null}
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
        tabIndex={expanded ? 0 : -1}
        disabled={!expanded}
        value={query}
        placeholder="搜索全部内容"
        onChange={(event) => onQueryChange(event.target.value)}
        onFocus={() => {
          setPinned(true);
          onSearchFocus?.();
        }}
      />
      {expanded && results && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panel}
              className="weq-titlebar-search-results"
              style={position}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
            >
              {results}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
