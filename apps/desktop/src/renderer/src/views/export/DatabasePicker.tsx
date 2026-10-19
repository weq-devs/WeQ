/**
 * Multi-select database picker for the decrypt flow.
 *
 * 数据库列表用**长方形卡片网格**呈现：每张卡片把数据库图标当作背景水印，
 * 正面是库名、大小、来源徽标和路径。点击卡片切换选中，键盘操作沿用
 * {@link useMultiSelection}（方向键 / 空格 / Ctrl+A）。
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
  /** `login` = 全局 login.db（固定密钥），其余为账号目录下的库。 */
  kind?: 'account' | 'login';
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
    <div className="weq-db-cards" {...selection.rootProps}>
      <div className="weq-db-cards-toolbar">
        <div className="weq-db-cards-search">
          <Search size={15} aria-hidden />
          <input
            placeholder="搜索数据库文件名或路径"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button type="button" title="清空" aria-label="清空搜索" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="weq-db-cards-tools">
          <button
            type="button"
            onClick={selectAll}
            disabled={disabled || filtered.length === 0}
            title={allFilteredSelected ? '取消全选' : '全选 (Ctrl/Command+A)'}
            aria-label={allFilteredSelected ? '取消全选' : '全选'}
          >
            <CheckCheck size={15} />
          </button>
          <button
            type="button"
            onClick={invert}
            disabled={disabled || filtered.length === 0}
            title="反选"
            aria-label="反选"
          >
            <FlipHorizontal2 size={15} />
          </button>
          <button
            type="button"
            onClick={() => onChange(new Set())}
            disabled={disabled || selected.size === 0}
            title="清空选择 (Ctrl/Command+Shift+A)"
            aria-label="清空选择"
          >
            <X size={15} />
          </button>
          <span className="weq-db-cards-count">
            已选 {selected.size} · {fmtBytes(selectedBytes)}
          </span>
        </div>
      </div>

      {loading ? (
        <PickerListSkeleton />
      ) : filtered.length === 0 ? (
        <div className="weq-db-cards-state">{query ? '没有匹配的数据库' : '未发现数据库文件'}</div>
      ) : (
        <div className="weq-db-cards-grid">
          {filtered.map((it) => {
            const checked = selected.has(it.path);
            return (
              <button
                key={it.path}
                type="button"
                className={`weq-db-card${checked ? ' is-on' : ''}`}
                disabled={disabled}
                aria-pressed={checked}
                title={it.path}
                {...selection.itemProps(it.path)}
              >
                {/* 背景水印：数据库图标 + 一圈柔光，纯装饰。 */}
                <span className="weq-db-card-watermark" aria-hidden>
                  <Database strokeWidth={1.2} />
                </span>
                <span className="weq-db-card-top">
                  <span className="weq-db-card-name">{it.name}</span>
                  {it.kind === 'login' ? <em className="weq-db-card-tag">全局</em> : null}
                  <span className="weq-db-card-check" aria-hidden>
                    {checked ? <Check size={13} strokeWidth={2.6} /> : null}
                  </span>
                </span>
                <span className="weq-db-card-meta">{fmtBytes(it.bytes)}</span>
                <span className="weq-db-card-path">{it.path}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
