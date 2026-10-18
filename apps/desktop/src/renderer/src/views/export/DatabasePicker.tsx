/**
 * Multi-select database picker for the decrypt flow.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, CheckCheck, Database, FlipHorizontal2, Search, X } from 'lucide-react';
import { PickerListSkeleton } from './ExportSkeleton';
import { fmtBytes } from './types';
import { useMultiSelection } from '../../hooks/useMultiSelection';

export interface DbPickItem {
  name: string;
  path: string;
  bytes: number;
}

export function DatabasePicker({
  items,
  loading,
  selected,
  onChange,
  disabled = false,
}: {
  items: DbPickItem[];
  loading: boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}): ReactElement {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) => it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q),
    );
  }, [items, query]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.path));
  const selectedBytes = items.reduce((sum, it) => sum + (selected.has(it.path) ? it.bytes : 0), 0);

  const selection = useMultiSelection({
    ids: filtered.map((item) => item.path),
    selected,
    onChange,
    disabled,
  });

  function selectAll(): void {
    const next = new Set(selected);
    if (allFilteredSelected) for (const it of filtered) next.delete(it.path);
    else for (const it of filtered) next.add(it.path);
    onChange(next);
  }

  function invert(): void {
    const next = new Set(selected);
    for (const it of filtered) {
      if (next.has(it.path)) next.delete(it.path);
      else next.add(it.path);
    }
    onChange(next);
  }

  return (
    <div className="weq-exp-picker" {...selection.rootProps}>
      <div className="weq-exp-search">
        <Search size={15} aria-hidden />
        <input
          placeholder="搜索数据库文件名或路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" title="清空" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="weq-exp-tools weq-exp-selection-tools">
        <button
          type="button"
          className="weq-exp-tool"
          onClick={selectAll}
          disabled={disabled || filtered.length === 0}
          title={allFilteredSelected ? '取消全选' : '全选 (Ctrl/Command+A)'}
          aria-label={allFilteredSelected ? '取消全选' : '全选'}
        >
          <CheckCheck size={14} />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={invert}
          disabled={disabled || filtered.length === 0}
          title="反选"
          aria-label="反选"
        >
          <FlipHorizontal2 size={14} />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={() => onChange(new Set())}
          disabled={disabled || selected.size === 0}
          title="清空 (Ctrl/Command+Shift+A)"
          aria-label="清空"
        >
          <X size={14} />
        </button>
        <span className="weq-exp-tools-spacer" />
        <span className="weq-exp-tools-count">
          已选 {selected.size} · {fmtBytes(selectedBytes)}
        </span>
      </div>

      <div className="weq-exp-list">
        {loading ? (
          <PickerListSkeleton />
        ) : filtered.length === 0 ? (
          <div className="weq-exp-list-state">
            {query ? '没有匹配的数据库' : '未发现数据库文件'}
          </div>
        ) : (
          filtered.map((it) => {
            const checked = selected.has(it.path);
            return (
              <button
                key={it.path}
                type="button"
                className={`weq-exp-row${checked ? ' is-on' : ''}`}
                disabled={disabled}
                {...selection.itemProps(it.path)}
              >
                <span className="weq-exp-db-icon">
                  <Database size={16} />
                </span>
                <span className="weq-exp-row-meta">
                  <strong title={it.name}>{it.name}</strong>
                  <small title={it.path}>
                    {fmtBytes(it.bytes)} · {it.path}
                  </small>
                </span>
                <span className="weq-exp-row-check" aria-hidden>
                  {checked ? <Check size={14} /> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
