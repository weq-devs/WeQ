import { useMemo, useEffect, useState, type MouseEvent } from 'react';
import { ArrowLeft, Edit3 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { QqArk } from './ark/QqArk';

interface ArkFeedViewProps {
  conversationId: string;
  title: string;
  onBack: () => void;
}

type ContextMenuState = {
  message: any;
  x: number;
  y: number;
};

export function ArkFeedView({ conversationId, title, onBack }: ArkFeedViewProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const isService = conversationId.startsWith('service:');
  const isOfficial = !isService && conversationId !== 'merged:official' && conversationId !== 'merged:service';

  const officialFeed = trpc.account.listOfficialAccountArkFeed.useQuery(
    { peerUid: conversationId, limit: 100 },
    { enabled: isOfficial }
  );

  const appId = isService ? conversationId.replace('service:', '') : '';
  const serviceFeed = trpc.account.listServiceAccountArkFeed.useQuery(
    { appId, limit: 100 },
    { enabled: isService }
  );

  useEffect(() => {
    if (isOfficial && officialFeed.data) {
      setMessages(officialFeed.data);
      setLoading(officialFeed.isLoading);
    } else if (isService && serviceFeed.data) {
      setMessages(serviceFeed.data);
      setLoading(serviceFeed.isLoading);
    }
  }, [isOfficial, isService, officialFeed.data, officialFeed.isLoading, serviceFeed.data, serviceFeed.isLoading]);

  const arkMessages = useMemo(() => {
    return messages.filter((msg) => {
      const elements = msg.elements || [];
      return elements.some((el: any) => el.type === 'ark');
    });
  }, [messages]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = () => setContextMenu(null);
    const handleScroll = () => setContextMenu(null);

    document.addEventListener('click', handleClick);
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [contextMenu]);

  function openMessageMenu(event: MouseEvent, message: any) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      message,
      x: Math.min(event.clientX, window.innerWidth - 126),
      y: Math.min(event.clientY, window.innerHeight - 84),
    });
  }

  function handleEditMessage(message: any) {
    setContextMenu(null);
    // 调用主窗口的编辑消息功能
    window.api?.openEditMessage?.(message.msgId);
  }

  return (
    <div className="weq-ark-feed-view">
      <div className="weq-ark-feed-header">
        <button type="button" className="weq-ark-feed-back" onClick={onBack}>
          <ArrowLeft size={20} />
        </button>
        <h2 className="weq-ark-feed-title">{title}</h2>
      </div>
      <div className="weq-ark-feed-body">
        {loading && arkMessages.length === 0 ? (
          <div className="weq-ark-feed-loading">加载中...</div>
        ) : arkMessages.length === 0 ? (
          <div className="weq-ark-feed-empty">暂无消息</div>
        ) : (
          arkMessages.map((msg) => {
            const arkElement = msg.elements?.find((el: any) => el.type === 'ark');
            if (!arkElement) return null;

            const timestamp = new Date(Number(msg.sendTime) * 1000);
            const timeStr = timestamp.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={msg.msgId}
                className="weq-ark-feed-item"
                onContextMenu={(e) => openMessageMenu(e, msg)}
              >
                <QqArk arkData={arkElement.data?.arkData} />
                <div className="weq-ark-feed-time">{timeStr}</div>
              </div>
            );
          })
        )}
      </div>

      {contextMenu && (
        <div
          className="weq-ark-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button type="button" onClick={() => handleEditMessage(contextMenu.message)}>
            <Edit3 size={17} />
            <span>修改</span>
          </button>
        </div>
      )}
    </div>
  );
}
