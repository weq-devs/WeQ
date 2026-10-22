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
import { ArrowLeft, Search, UserRound, UsersRound } from 'lucide-react';
import { QQExactLookup, type QQExactLookupKind } from './QQExactLookup';

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
  const [lookupOpen, setLookupOpen] = useState<QQExactLookupKind | null>(null);
  const numericQuery = /^[1-9]\d{0,9}$/.test(query.trim()) && BigInt(query.trim()) <= 0xffffffffn;
  const [hovered, setHovered] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  const expanded = pinned || (hovered && !suppressHover);
  const hasPanel = Boolean(results) || pinned;
  const layer = useOverlayLayer(expanded && hasPanel);

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
    if (!expanded || lookupOpen) return;
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
  }, [expanded, lookupOpen]);

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
        if (lookupOpen) return;
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
      {lookupOpen && (
        <QQExactLookup
          key={lookupOpen}
          kind={lookupOpen}
          initial={numericQuery ? query.trim() : ''}
          onClose={() => setLookupOpen(null)}
        />
      )}
      {expanded && hasPanel && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panel}
              className="weq-titlebar-search-results"
              style={{ ...position, zIndex: layer }}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
            >
              {results}
              {pinned &&
                (['user', 'group'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="weq-cloud-lookup-entry"
                    aria-label={kind === 'user' ? 'QQ 号搜索' : '群号搜索'}
                    onClick={() => {
                      setPinned(true);
                      setLookupOpen(kind);
                    }}
                  >
                    {kind === 'user' ? <UserRound size={16} /> : <UsersRound size={16} />}
                    {kind === 'user' ? 'QQ 号搜索' : '群号搜索'}
                    {numericQuery ? ` ${query.trim()}` : ''}
                  </button>
                ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
