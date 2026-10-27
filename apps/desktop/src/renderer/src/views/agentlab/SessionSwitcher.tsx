/**
 * 克隆体 / 克隆群会话头部的「会话切换器」。
 *
 * 克隆体被放进会话列表后，左栏没了；但会话仍然是一对多的（一个克隆体可以有多段
 * 对话）。这里把原来左栏那套「新建 + 切换 + 删除」搬进对话内部，避免出现
 * 「历史记录里能看到好几段对话，却没有任何入口切换」的死角。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, ChevronDown, History, MessageSquarePlus, Trash2, Eraser } from 'lucide-react';
import type { AgentLabSession } from '@weq/service';
import { OverlayLayer } from '../../components/OverlayLayer';
import { useTabActive } from '../../components/RetainedTabs';
import '../../styles/workspace-surfaces.css';

export function SessionSwitcher({
  sessions,
  activeSessionId,
  draft,
  loading,
  disabled,
  compact = false,
  onSwitch,
  onNew,
  onDelete,
  onClear,
  clearDisabled = false,
}: {
  sessions: AgentLabSession[];
  /** 当前会话 id；null = 还没落库的草稿会话。 */
  activeSessionId: string | null;
  /** 当前正处在一段未落库的新草稿里（标题显示为「新会话」）。 */
  draft: boolean;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onSwitch: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onClear?: () => void;
  clearDisabled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const tabActive = useTabActive();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [activeSessionId, disabled, tabActive]);
  const active = sessions.find((session) => session.id === activeSessionId);
  return (
    <div className="weq-session-switcher">
      <button
        ref={trigger}
        type="button"
        className={
          compact ? 'icon-button group-header-info-action' : 'weq-session-switcher-trigger'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="切换会话"
        title={compact ? `切换会话 · ${draft ? '新会话' : active?.title || '新会话'}` : '切换会话'}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {compact ? (
          <History size={18} />
        ) : (
          <>
            <span className="weq-session-switcher-title">
              {draft ? '新会话' : active?.title || '新会话'}
            </span>
            <small>{sessions.length}</small>
            <ChevronDown size={13} />
          </>
        )}
      </button>
      {open ? (
        <OverlayLayer
          presentation="popover"
          anchor={trigger.current}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <div className="weq-session-switcher-menu" role="menu" aria-label="会话列表">
            <button
              type="button"
              role="menuitem"
              className="weq-session-switcher-new"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              <MessageSquarePlus size={13} />
              新建会话
            </button>
            {onClear ? (
              <button
                type="button"
                role="menuitem"
                className="weq-session-switcher-new"
                disabled={clearDisabled}
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
              >
                <Eraser size={13} />
                清空当前对话
              </button>
            ) : null}
            <div className="weq-session-switcher-list">
              {loading && sessions.length === 0 ? (
                <p className="weq-session-switcher-empty">读取会话中…</p>
              ) : sessions.length === 0 ? (
                <p className="weq-session-switcher-empty">还没有会话，发第一句就会自动保存。</p>
              ) : (
                sessions.map((session) => {
                  const current = session.id === activeSessionId;
                  return (
                    <div
                      key={session.id}
                      className={`weq-session-switcher-row${current ? ' is-active' : ''}`}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="weq-session-switcher-open"
                        onClick={() => {
                          setOpen(false);
                          onSwitch(session.id);
                        }}
                      >
                        <span className="weq-session-switcher-mark" aria-hidden>
                          {current ? <Check size={12} /> : null}
                        </span>
                        <span className="weq-session-switcher-text">
                          <strong>{session.title || '新会话'}</strong>
                          <small>{relTime(session.updatedAt)}</small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="weq-session-switcher-del"
                        aria-label={`删除会话 ${session.title || '新会话'}`}
                        title="删除这段会话"
                        onClick={() => onDelete(session.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </OverlayLayer>
      ) : null}
    </div>
  );
}

/** 相对时间（列表够用即可）。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}
