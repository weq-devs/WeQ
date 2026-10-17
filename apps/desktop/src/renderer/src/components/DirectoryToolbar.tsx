import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ListChecks, ListPlus, Search, X } from 'lucide-react';
import '../styles/conversation-directory.css';

/** 搜索与选择在同一条工具行内展开，列表区的位置和宽度不变。 */
export function DirectoryToolbar({
  noun,
  query,
  onQuery,
  selecting,
  onSelecting,
  count,
  onSelectAll,
  children,
}: {
  noun: string;
  query: string;
  onQuery: (query: string) => void;
  selecting: boolean;
  onSelecting: (value: boolean) => void;
  count: number;
  onSelectAll: () => void;
  children?: ReactNode;
}) {
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching && !selecting) input.current?.focus();
  }, [searching, selecting]);
  const closeSearch = () => {
    onQuery('');
    setSearching(false);
  };
  return (
    <div
      className={`weq-directory-toolbar${searching ? ' is-searching' : ''}${selecting ? ' is-selecting' : ''}`}
    >
      {selecting ? (
        <div key="select" className="weq-directory-mode weq-directory-selection-mode">
          <ListChecks size={16} aria-hidden />
          <span className="weq-directory-selection-count" aria-live="polite">
            已选 {count}
          </span>
          <button
            type="button"
            title="全选当前结果"
            aria-label="全选当前结果"
            onClick={onSelectAll}
          >
            <ListPlus size={16} />
          </button>
          <button
            type="button"
            title="退出多选"
            aria-label="退出多选"
            onClick={() => onSelecting(false)}
          >
            <X size={16} />
          </button>
        </div>
      ) : searching ? (
        <div key="search" className="weq-directory-mode">
          <Search size={16} aria-hidden />
          <input
            ref={input}
            value={query}
            aria-label={`搜索${noun}名称或号码`}
            placeholder={`搜索${noun}`}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
          />
          <button
            type="button"
            title={`退出搜索${noun}`}
            aria-label={`退出搜索${noun}`}
            onClick={closeSearch}
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <>
          <button
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
    </div>
  );
}
