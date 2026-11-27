import { NumericText } from './NumericText';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ListChecks, ListPlus, Search, X, FlipVertical2 } from 'lucide-react';
import { useExitMotion } from '../hooks/useExitMotion';
import '../styles/conversation-directory.css';

/** 搜索与选择在同一条工具行内展开，列表区的位置和宽度不变。 */
export function DirectoryToolbar({
  noun,
  query,
  onQuery,
  selecting,
  onSelecting,
  count,
  allSelected = false,
  onSelectAll,
  onInvert,
  selectingAll = false,
  children,
  separateSelectionBar = false,
  searchEnabled = true,
  endAction,
  searchActions,
}: {
  noun: string;
  query: string;
  onQuery: (query: string) => void;
  selecting: boolean;
  onSelecting: (value: boolean) => void;
  count: number;
  allSelected?: boolean;
  onSelectAll: () => void;
  onInvert?: () => void;
  selectingAll?: boolean;
  children?: ReactNode;
  separateSelectionBar?: boolean;
  searchEnabled?: boolean;
  endAction?: (searching: boolean, closeSearch: () => void) => ReactNode;
  searchActions?: ReactNode;
}) {
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searchMode = useRef<HTMLDivElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const activeSearch = searching && searchEnabled && (!selecting || separateSelectionBar);
  const showSearch = useExitMotion(searchMode, activeSearch);
  useEffect(() => {
    if (query) setSearching(true);
  }, [query]);
  useEffect(() => {
    if (activeSearch) {
      restoreFocus.current = false;
      input.current?.focus();
    }
  }, [activeSearch]);
  useLayoutEffect(() => {
    if (showSearch || !restoreFocus.current) return;
    restoreFocus.current = false;
    const button = searchButton.current;
    const focused = button?.ownerDocument.activeElement;
    if (focused === button?.ownerDocument.body || button?.parentElement?.contains(focused ?? null))
      button?.focus({ preventScroll: true });
  }, [showSearch]);
  const closeSearch = () => {
    restoreFocus.current = true;
    onQuery('');
    setSearching(false);
  };
  return (
    <div
      className={`weq-directory-toolbar${searching ? ' is-searching' : ''}${selecting && !separateSelectionBar ? ' is-selecting' : ''}`}
    >
      {selecting && !separateSelectionBar ? (
        <div key="select" className="weq-directory-mode weq-directory-selection-mode">
          <ListChecks size={16} aria-hidden />
          <span className="weq-directory-selection-count" aria-live="polite">
            {selectingAll ? '正在补齐全选…' : <NumericText>{`已选 ${count}`}</NumericText>}
          </span>
          <button
            type="button"
            title={allSelected ? '取消全选当前结果' : '全选当前结果'}
            aria-label={allSelected ? '取消全选当前结果' : '全选当前结果'}
            aria-pressed={allSelected}
            onClick={onSelectAll}
          >
            <ListPlus size={16} />
          </button>
          {onInvert ? (
            <button
              type="button"
              title="反选当前结果"
              aria-label="反选当前结果"
              disabled={selectingAll}
              onClick={onInvert}
            >
              <FlipVertical2 size={16} />
            </button>
          ) : null}
          <button
            type="button"
            title="退出多选"
            aria-label="退出多选"
            onClick={() => onSelecting(false)}
          >
            <X size={16} />
          </button>
        </div>
      ) : showSearch && searchEnabled ? (
        <div
          key="search"
          ref={searchMode}
          className="weq-directory-mode"
          data-closing={!activeSearch || undefined}
          inert={!activeSearch}
        >
          <Search size={16} aria-hidden />
          <input
            ref={input}
            value={query}
            aria-label={`搜索${noun}名称或号码`}
            placeholder={`搜索${noun}`}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }}
          />
          {searchActions}
          {!endAction && (
            <button
              type="button"
              title={`退出搜索${noun}`}
              aria-label={`退出搜索${noun}`}
              onClick={closeSearch}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ) : (
        <>
          {searchEnabled ? (
            <button
              ref={searchButton}
              type="button"
              title={`搜索${noun}`}
              aria-label={`搜索${noun}`}
              aria-expanded={searching}
              onClick={() => {
                setSearching(true);
              }}
            >
              <Search size={16} />
            </button>
          ) : null}
          <button
            type="button"
            title={`多选${noun}`}
            aria-label={`多选${noun}`}
            aria-pressed={selecting}
            onClick={() => onSelecting(!selecting)}
          >
            <ListChecks size={16} />
          </button>
          {children}
        </>
      )}
      {(!selecting || separateSelectionBar) && endAction?.(searching && searchEnabled, closeSearch)}
    </div>
  );
}
