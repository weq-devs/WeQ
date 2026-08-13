import { X, EyeOff } from 'lucide-react';
import { useMemo, useEffect, useRef, useState } from 'react';
import { Avatar } from '../../im-template/template/primitives';
import type { Conversation, MergedKind } from '../../im-template/template/types';

interface MergedSessionPanelProps {
  kind: MergedKind;
  conversations: Conversation[];
  anchorX: number;
  anchorY: number;
  onBack: () => void;
  onSelectConversation: (conv: Conversation) => void;
}

export function MergedSessionPanel({
  kind,
  conversations,
  anchorX,
  anchorY,
  onBack,
  onSelectConversation,
}: MergedSessionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: anchorX, y: anchorY });

  // 计算面板位置，确保不超出视口
  useEffect(() => {
    if (!panelRef.current) return;

    const panel = panelRef.current;
    const rect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = anchorX;
    let y = anchorY;

    // 默认显示在右侧
    const showOnRight = x + 340 < viewportWidth;
    if (showOnRight) {
      x = Math.min(x, viewportWidth - 340 - 12);
    } else {
      // 放不下就显示在左侧
      x = Math.max(12, x - 340);
    }

    // 垂直方向：尽量对齐点击位置，但不超出视口
    y = Math.max(12, Math.min(y, viewportHeight - rect.height - 12));

    setPosition({ x, y });
  }, [anchorX, anchorY]);

  // 点击面板外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onBack();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onBack]);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  const filtered = useMemo(() => {
    if (kind === 'hidden') {
      return conversations.filter((c) => c.hidden === true);
    }
    if (kind === 'service') {
      return conversations.filter((c) => c.type === 'direct' && c.chatType === 118);
    }
    if (kind === 'official') {
      return conversations.filter((c) => c.type === 'direct' && c.chatType === 103);
    }
    return [];
  }, [kind, conversations]);

  const sortedThreads = useMemo(
    () =>
      filtered.slice().sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      }),
    [filtered],
  );

  const title =
    kind === 'hidden' ? '隐藏的会话' : kind === 'service' ? 'QQ服务号' : 'QQ官方账号';

  return (
    <div className="weq-merged-overlay">
      <div
        ref={panelRef}
        className="weq-merged-popover"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div className="weq-merged-popover-header">
          <div className="weq-merged-popover-title">{title}</div>
          <button type="button" className="weq-merged-popover-close" onClick={onBack}>
            <X size={16} />
          </button>
        </div>
        <div className="weq-merged-popover-body">
          {sortedThreads.map((conv) => {
            const preview = conv.lastMessage?.body ?? '';
            const time = conv.updatedAt
              ? new Date(conv.updatedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
            const name =
              conv.type === 'group'
                ? conv.group?.name
                : conv.type === 'direct'
                  ? conv.otherUser?.displayName
                  : conv.id;
            const avatarUrl =
              conv.type === 'group'
                ? conv.group?.avatarUrl
                : conv.type === 'direct'
                  ? conv.otherUser?.avatarUrl
                  : null;
            const seed = conv.type === 'direct' ? conv.otherUser?.identityValue : conv.id;

            return (
              <button
                key={conv.id}
                type="button"
                className="weq-merged-popover-item"
                onClick={() => {
                  onSelectConversation(conv);
                  onBack();
                }}
              >
                <Avatar name={name ?? ''} avatarUrl={avatarUrl} seed={seed ?? conv.id} />
                <div className="weq-merged-popover-item-main">
                  <div className="weq-merged-popover-item-top">
                    <div className="weq-merged-popover-item-name">{name}</div>
                    {time && <div className="weq-merged-popover-item-time">{time}</div>}
                  </div>
                  {preview && (
                    <div className="weq-merged-popover-item-preview">{preview}</div>
                  )}
                </div>
                {kind === 'hidden' && conv.hidden && (
                  <EyeOff size={14} className="weq-merged-popover-item-badge" />
                )}
              </button>
            );
          })}
          {sortedThreads.length === 0 && (
            <div className="weq-merged-popover-empty">暂无会话</div>
          )}
        </div>
      </div>
    </div>
  );
}
