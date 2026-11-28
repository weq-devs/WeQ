/**
 * 小Q 的 session 切换器。
 *
 * 小Q 主入口（10000）在会话列表里只占一项，点进来之后才能看到它下面新开的
 * 子会话。这里做成一个下拉：主入口置顶，其余按最后消息时间排。
 *
 * 纯本机状态切换，不触发任何 QQ 操作。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MessageSquare } from 'lucide-react';
import type { AiAssistantSessionWire } from '../../../../shared/aiAssistantTypes';

export function AiSessionSwitcher({
  sessions,
  activeSessionId,
  fallbackTitle,
  error,
  onSelect,
}: {
  sessions: readonly AiAssistantSessionWire[];
  activeSessionId: string;
  fallbackTitle: string;
  error?: string;
  onSelect: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // 列表还没读到时不占位；读到了就显示 —— 哪怕只有一个会话，用户也需要看到
  // 自己正在看哪个 session（否则「没法切换」看起来像功能缺失）。
  if (sessions.length === 0 && !error) return null;

  const active = sessions.find((row) => row.sessionId === activeSessionId);
  const main = sessions.filter((row) => row.isMain);
  const others = sessions.filter((row) => !row.isMain);
  // 主会话统一叫「小Q」；子会话用标题（会话标题是用户提问的摘要）。
  const labelOf = (row: AiAssistantSessionWire) =>
    row.isMain ? '小Q' : row.title || row.sessionId;
  const label = active ? labelOf(active) : fallbackTitle || '选择会话';

  return (
    <div className="ai-session-switcher" ref={rootRef}>
      <button
        type="button"
        className="ai-session-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={error || '切换小Q 会话'}
        onClick={() => setOpen((value) => !value)}
      >
        <MessageSquare size={14} aria-hidden />
        <span className="ai-session-switcher-label">{label}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div className="ai-session-switcher-menu" role="listbox" aria-label="小Q 会话">
          {error ? <div className="ai-session-switcher-error">{error}</div> : null}
          {[...main, ...others].map((row) => (
            <button
              key={row.sessionId}
              type="button"
              role="option"
              aria-selected={row.sessionId === activeSessionId}
              className={`ai-session-switcher-item${
                row.sessionId === activeSessionId ? ' is-active' : ''
              }`}
              onClick={() => {
                setOpen(false);
                onSelect(row.sessionId);
              }}
            >
              <span className="ai-session-switcher-item-title">{labelOf(row)}</span>
              <span className="ai-session-switcher-item-meta">{row.messageCount} 条</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
