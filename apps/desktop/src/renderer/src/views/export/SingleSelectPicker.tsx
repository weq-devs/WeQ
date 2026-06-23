/**
 * 单选列表（群相册选群 / 解密数据库选库 共用）。可搜索，行末单选标记。
 * 选中项由父组件以 id 持有；空列表时可显示一段说明（如「后端待接入」）。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Circle, CircleDot, Search, X } from 'lucide-react';
import { Avatar, Spinner } from './widgets';
import type { PickItem } from './types';

export function SingleSelectPicker({
  items,
  loading,
  selectedId,
  onSelect,
  searchPlaceholder = '搜索',
  emptyText = '暂无可选项',
  hint,
}: {
  items: PickItem[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  hint?: string;
}): ReactElement {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <div className="weq-exp-picker">
      <div className="weq-exp-search">
        <Search size={15} aria-hidden />
        <input placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query ? (
          <button type="button" title="清空" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="weq-exp-list">
        {loading ? (
          <div className="weq-exp-list-state">
            <Spinner size={18} />
            加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="weq-exp-list-state">
            <span>{query ? '没有匹配项' : emptyText}</span>
            {!query && hint ? <small className="weq-exp-list-hint">{hint}</small> : null}
          </div>
        ) : (
          filtered.map((it) => {
            const active = it.id === selectedId;
            return (
              <button
                key={it.id}
                type="button"
                className={`weq-exp-row${active ? ' is-on' : ''}`}
                onClick={() => onSelect(it.id)}
              >
                <Avatar url={it.avatarUrl} name={it.name} size={38} />
                <span className="weq-exp-row-meta">
                  <strong title={it.name}>{it.name}</strong>
                  {it.meta ? <small>{it.meta}</small> : null}
                </span>
                <span className={`weq-exp-radio${active ? ' is-on' : ''}`} aria-hidden>
                  {active ? <CircleDot size={18} /> : <Circle size={18} />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
