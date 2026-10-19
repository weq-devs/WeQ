/**
 * 多选会话列表（完整消息 / ChatLab / 定时 三种模式共用）。
 *
 * 视觉沿用关系图谱的 GroupPickerModal：可搜索、头像 + 名称 + 次要信息行、
 * 行末勾选标记；工具条提供全选（当前筛选）/ 反选 / 清空 与已选计数。选择状态
 * 由父组件以 Set<string> 持有，本组件只负责呈现与回调。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, CheckCheck, FlipHorizontal2, Search, SlidersHorizontal, X } from 'lucide-react';
import { Avatar } from './widgets';
import { PickerListSkeleton } from './ExportSkeleton';
import type { PickItem } from './types';
import { WindowedList } from '../../components/WindowedList';
import { useMultiSelection } from '../../hooks/useMultiSelection';

export function ConversationPicker({
  items,
  loading,
  selected,
  onChange,
  emptyText = '暂无可导出的会话',
  onEditScope,
  scopeSelections,
  scopeLabel = '消息范围',
  scopeUnit = '条消息',
  searchPlaceholder = '搜索会话名称或号码',
}: {
  items: PickItem[];
  loading: boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyText?: string;
  onEditScope?: (item: PickItem) => void;
  scopeSelections?: Readonly<Record<string, readonly string[]>>;
  scopeLabel?: string;
  scopeUnit?: string;
  searchPlaceholder?: string;
}): ReactElement {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) => it.name.toLowerCase().includes(q) || it.id.includes(q) || it.uin?.includes(q),
    );
  }, [items, query]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.id));
  const selection = useMultiSelection({ ids: filtered.map((item) => item.id), selected, onChange });

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
    <div className="weq-exp-picker" {...selection.rootProps}>
      <div className="weq-exp-search">
        <Search size={15} aria-hidden />
        <input
          placeholder={searchPlaceholder}
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
          disabled={filtered.length === 0}
          title={allFilteredSelected ? '取消全选' : '全选 (Ctrl/Command+A)'}
          aria-label={allFilteredSelected ? '取消全选' : '全选'}
        >
          <CheckCheck size={14} />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={invert}
          title="反选"
          aria-label="反选"
          disabled={filtered.length === 0}
        >
          <FlipHorizontal2 size={14} />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={() => onChange(new Set())}
          title="清空 (Ctrl/Command+Shift+A)"
          aria-label="清空"
          disabled={selected.size === 0}
        >
          <X size={14} />
        </button>
        <span className="weq-exp-tools-spacer" />
        <span className="weq-exp-tools-count">已选 {selected.size}</span>
      </div>

      <div className="weq-exp-list">
        {loading ? (
          <PickerListSkeleton />
        ) : filtered.length === 0 ? (
          <div className="weq-exp-list-state">{query ? '没有匹配的会话' : emptyText}</div>
        ) : (
          <WindowedList
            items={filtered}
            rowHeight={64}
            height={480}
            itemKey={(it) => it.id}
            scrollToKey={selection.focusRequest?.id}
            scrollRevision={selection.focusRequest?.revision}
            renderItem={(it) => {
              const checked = selected.has(it.id);
              return (
                <div className="weq-export-conversation-row">
                  <button
                    type="button"
                    className={`weq-exp-row${checked ? ' is-on' : ''}`}
                    style={{ height: '100%', width: '100%', minWidth: 0 }}
                    aria-pressed={checked}
                    {...selection.itemProps(it.id)}
                  >
                    <Avatar url={it.avatarUrl} name={it.name} size={38} />
                    <span className="weq-exp-row-meta">
                      <strong title={it.name}>{it.name}</strong>
                      {scopeSelections?.[it.id] !== undefined ? (
                        <small>
                          精确选中 {scopeSelections[it.id]!.length} {scopeUnit}
                        </small>
                      ) : it.meta ? (
                        <small>{it.meta}</small>
                      ) : null}
                    </span>
                    <span className="weq-exp-row-check" aria-hidden>
                      {checked ? <Check size={14} /> : null}
                    </span>
                  </button>
                  {onEditScope ? (
                    <button
                      className="weq-export-edit-scope"
                      type="button"
                      title={`调整 ${it.name} 的${scopeLabel}`}
                      aria-label={`调整 ${it.name} 的${scopeLabel}`}
                      onClick={() => onEditScope(it)}
                    >
                      <SlidersHorizontal size={15} />
                    </button>
                  ) : null}
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
