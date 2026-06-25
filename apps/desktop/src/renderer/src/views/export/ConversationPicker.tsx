/**
 * 多选会话列表（完整消息 / ChatLab / 定时 三种模式共用）。
 *
 * 视觉沿用关系图谱的 GroupPickerModal：可搜索、头像 + 名称 + 次要信息行、
 * 行末勾选标记；工具条提供全选（当前筛选）/ 反选 / 清空 与已选计数。选择状态
 * 由父组件以 Set<string> 持有，本组件只负责呈现与回调。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, CheckCheck, FlipHorizontal2, Search, X } from 'lucide-react';
import { Avatar, Spinner } from './widgets';
import type { PickItem } from './types';

export function ConversationPicker({
  items,
  loading,
  selected,
  onChange,
  emptyText = '暂无可导出的会话',
}: {
  items: PickItem[];
  loading: boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyText?: string;
}): ReactElement {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q));
  }, [items, query]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.id));

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function selectAll(): void {
    const next = new Set(selected);
    if (allFilteredSelected) for (const it of filtered) next.delete(it.id);
    else for (const it of filtered) next.add(it.id);
    onChange(next);
  }

  function invert(): void {
    const next = new Set(selected);
    for (const it of filtered) {
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
    }
    onChange(next);
  }

  return (
    <div className="weq-exp-picker">
      <div className="weq-exp-search">
        <Search size={15} aria-hidden />
        <input
          placeholder="搜索会话名称或号码"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" title="清空" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="weq-exp-tools">
        <button type="button" className="weq-exp-tool" onClick={selectAll} disabled={filtered.length === 0}>
          <CheckCheck size={14} />
          {allFilteredSelected ? '取消全选' : '全选'}
        </button>
        <button type="button" className="weq-exp-tool" onClick={invert} disabled={filtered.length === 0}>
          <FlipHorizontal2 size={14} />
          反选
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={() => onChange(new Set())}
          disabled={selected.size === 0}
        >
          <X size={14} />
          清空
        </button>
        <span className="weq-exp-tools-spacer" />
        <span className="weq-exp-tools-count">已选 {selected.size}</span>
      </div>

      <div className="weq-exp-list">
        {loading ? (
          <div className="weq-exp-list-state">
            <Spinner size={18} />
            加载会话中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="weq-exp-list-state">{query ? '没有匹配的会话' : emptyText}</div>
        ) : (
          filtered.map((it) => {
            const checked = selected.has(it.id);
            return (
              <button
                key={it.id}
                type="button"
                className={`weq-exp-row${checked ? ' is-on' : ''}`}
                onClick={() => toggle(it.id)}
              >
                <Avatar url={it.avatarUrl} name={it.name} size={38} />
                <span className="weq-exp-row-meta">
                  <strong title={it.name}>{it.name}</strong>
                  {it.meta ? <small>{it.meta}</small> : null}
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
