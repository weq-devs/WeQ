/**
 * AI 助手（小Q）会话面板。
 *
 * 与公众号 / 服务号同一套只读语义：`ChatPane` 关掉输入区，消息渲染换成
 * `aiMessageRenderer`。额外多一层 session 切换 —— 小Q 主入口（10000）是从会话
 * 列表点进来的那个，点进后还能看它下面新开的子会话。
 *
 * 入口：会话列表里 chatType 45 的那一项 → 这里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareText, RefreshCw } from 'lucide-react';
import '../../styles/ai-assistant.css';
import { client } from '../../trpc/client';
import { accountBinding } from '../../lib/clientPreferences';
import { aiAssistantAvatarDataUri } from '../../lib/aiAssistantAvatar';
import { ChatPane } from '../../im-template/template/chatPane';
import { composeMessageRenderers } from '../../im-template/template/messageRenderers';
import type { DirectConversation, User } from '../../im-template/template/types';
import { ForwardKindContext } from '../../state/messageContext';
import { EmptyState } from '../EmptyState';
import { qqMessageRenderer } from '../QqMessageContent.shared';
import { aiMessageRenderer } from './aiMessageRenderer';
import { AiSessionSwitcher } from './AiSessionSwitcher';
import { aiMessagesToTimeline } from './aiTimeline';
import type {
  AiAssistantMessageWire,
  AiAssistantSessionWire,
} from '../../../../shared/aiAssistantTypes';

const renderers = composeMessageRenderers({ prepend: [aiMessageRenderer, qqMessageRenderer] });
const emptyDraft = () => {};
const noSend = async () => {
  throw new Error('AI 助手只读，暂不支持发送消息');
};

export function AiAssistantPane({
  conversationId,
  user,
  sessionId: initialSessionId,
  onBack,
}: {
  conversationId: string;
  user: User;
  /** 打开时默认展示的 sessionId；缺省用小Q 主入口（10000）。 */
  sessionId?: string;
  onBack: () => void;
}) {
  const binding = accountBinding();
  const [sessionId, setSessionId] = useState(initialSessionId ?? '10000');
  const [sessions, setSessions] = useState<AiAssistantSessionWire[]>([]);
  const [messages, setMessages] = useState<AiAssistantMessageWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sessionsError, setSessionsError] = useState('');
  const request = useRef(0);

  // 会话列表：切换子会话、显示条数与最后时间。
  const loadSessions = useCallback(async () => {
    setSessionsError('');
    try {
      const rows = await client.account.listAiAssistantSessions.query();
      setSessions(rows);
    } catch (reason) {
      setSessionsError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // 当前会话的消息。
  const loadMessages = useCallback(
    async (target: string) => {
      const version = ++request.current;
      setLoading(true);
      setError('');
      try {
        const rows = await client.account.listAiAssistantMessages.query({
          sessionId: target,
          ...(binding ?? {}),
        });
        if (version !== request.current) return;
        setMessages(rows);
      } catch (reason) {
        if (version !== request.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setMessages([]);
      } finally {
        if (version === request.current) setLoading(false);
      }
    },
    [binding],
  );

  useEffect(() => {
    void loadMessages(sessionId);
    return () => {
      request.current += 1;
    };
  }, [sessionId, loadMessages]);

  const activeSession = sessions.find((row) => row.sessionId === sessionId);
  // 会话标题固定为「小Q」：sessionId（如 10000）只是内部键，不该露在标题栏。
  // 头像与会话列表一致（自绘 SVG），避免头部回退到首字母占位。
  const conversation = useMemo<DirectConversation>(
    () => ({
      id: conversationId,
      type: 'direct',
      directoryKind: 'aiAssistant' as DirectConversation['directoryKind'],
      chatType: 45,
      otherUser: {
        id: conversationId,
        displayName: '小Q',
        username: conversationId,
        identityLabel: 'AI',
        identityValue: '',
        // 与会话列表同一张自绘头像；kind='bot' 让头部显示机器人标记。
        kind: 'bot',
        avatarUrl: aiAssistantAvatarDataUri(),
      },
      group: null,
      members: [],
      updatedAt: '',
      lastMessage: null,
    }),
    [conversationId],
  );

  const timeline = useMemo(
    () => aiMessagesToTimeline(messages, conversation, user),
    [messages, conversation, user],
  );

  return (
    <ForwardKindContext.Provider value="aiAssistant">
      <ChatPane
        user={user}
        conversation={conversation}
        messages={timeline}
        messageRenderers={renderers}
        loading={loading && messages.length === 0}
        loadError={error || undefined}
        composerVisible={false}
        readOnly
        sendAvailable={false}
        preference={undefined}
        draft=""
        onDraftChange={emptyDraft}
        onDraftClear={emptyDraft}
        onSend={noSend}
        onBack={onBack}
        atLatest
        headerActions={
          <AiSessionSwitcher
            sessions={sessions}
            activeSessionId={sessionId}
            fallbackTitle="小Q"
            error={sessionsError}
            onSelect={(next) => setSessionId(next)}
          />
        }
        timelineNotice={
          error ? (
            <button
              type="button"
              className="icon-button"
              aria-label="重新读取消息"
              title="重新读取消息"
              onClick={() => void loadMessages(sessionId)}
            >
              <RefreshCw size={16} aria-hidden />
            </button>
          ) : null
        }
        emptyTimeline={
          activeSession && activeSession.messageCount === 0 ? (
            <EmptyState
              title="这个会话还没有消息"
              body="AI 助手的会话内容在 QQ 内产生，WeQ 只做只读展示。"
              icon={<MessageSquareText />}
            />
          ) : undefined
        }
      />
    </ForwardKindContext.Provider>
  );
}
