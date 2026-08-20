/** Chat-record modal: left = matched conversations, right = their matching messages. */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { Modal } from '../Dialog';
import { SearchListSkeleton } from './SearchSkeleton';
import { c2cAvatarSrc, groupAvatarSrc, highlightText } from './SearchResultCard';
import type {
  ChatRecordSearchHit,
  ConversationRecordHit,
  MoreSearchResult,
} from './types';
import { client } from '../../trpc/client';

export function ChatRecordsModal({
  initialHit,
  initialKeyword,
  onClose,
  onJumpMessage,
  pushToast,
}: {
  initialHit: ChatRecordSearchHit;
  initialKeyword: string;
  onClose: () => void;
  /** Jump to a conversation + seq (like a file hit). */
  onJumpMessage: (hit: { source: 'buddy' | 'group'; targetUid: string; msgSeq: string }) => void;
  pushToast: (t: { tone: 'info'; title: string }) => void;
}): ReactElement {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [conversations, setConversations] = useState<ChatRecordSearchHit[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [selected, setSelected] = useState<ChatRecordSearchHit | null>(initialHit);
  const [messages, setMessages] = useState<ConversationRecordHit[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [msgTotal, setMsgTotal] = useState(0);
  const convRunRef = useRef(0);
  const msgRunRef = useRef(0);
  const msgScrollRef = useRef<HTMLDivElement | null>(null);

  // Fetch the conversation ranking for the current keyword.
  useEffect(() => {
    const trimmed = keyword.trim();
    if (!trimmed) return undefined;
    const run = ++convRunRef.current;
    setConvLoading(true);
    const timer = window.setTimeout(() => {
      void client.account.searchMore
        .query({ category: 'chatRecord', keyword: trimmed, offset: 0, limit: 100 })
        .then((result) => {
          if (run !== convRunRef.current) return;
          const items = ((result as MoreSearchResult).items ?? []) as ChatRecordSearchHit[];
          setConversations(items);
          // Keep the selection valid: prefer the previously selected conversation.
          setSelected((prev) =>
            prev && items.some((c) => c.partition === prev.partition && c.source === prev.source)
              ? prev
              : (items[0] ?? null),
          );
        })
        .catch((err) => console.error('[chat-records] conversation list failed', err))
        .finally(() => {
          if (run === convRunRef.current) setConvLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  // Fetch messages for the selected conversation.
  useEffect(() => {
    const trimmed = keyword.trim();
    if (!trimmed || !selected) {
      setMessages([]);
      setMsgTotal(0);
      return undefined;
    }
    const run = ++msgRunRef.current;
    setMsgLoading(true);
    void client.account.searchConversationRecords
      .query({
        source: selected.source,
        conv: selected.targetUid,
        keyword: trimmed,
        offset: 0,
        limit: 30,
      })
      .then((result) => {
        if (run !== msgRunRef.current) return;
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages(r.items);
        setMsgTotal(r.total);
        if (r.items.length === 0) {
          pushToast({ tone: 'info', title: '没有找到相关消息' });
        }
      })
      .catch((err) => console.error('[chat-records] messages failed', err))
      .finally(() => {
        if (run === msgRunRef.current) setMsgLoading(false);
      });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, [selected, keyword, pushToast]);

  const loadMoreMessages = useCallback(() => {
    const trimmed = keyword.trim();
    if (!trimmed || !selected || msgLoadingMore) return;
    setMsgLoadingMore(true);
    void client.account.searchConversationRecords
      .query({
        source: selected.source,
        conv: selected.targetUid,
        keyword: trimmed,
        offset: messages.length,
        limit: 30,
      })
      .then((result) => {
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages((prev) => [...prev, ...r.items]);
        setMsgTotal(r.total);
      })
      .catch((err) => console.error('[chat-records] load more failed', err))
      .finally(() => setMsgLoadingMore(false));
  }, [keyword, selected, messages.length, msgLoadingMore]);

  // Infinite scroll for the message list.
  const onMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (!el || msgLoading || msgLoadingMore || messages.length >= msgTotal) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void loadMoreMessages();
    }
  }, [messages.length, msgTotal, msgLoading, msgLoadingMore, loadMoreMessages]);

  return (
    <Modal onClose={onClose} labelledBy="weq-chatrecords-title" width={960}>
      <div className="weq-chatrecords">
        <div className="weq-chatrecords-head">
          <h3 id="weq-chatrecords-title" className="weq-search-more-title">
            聊天记录
          </h3>
          <button type="button" className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <input
          className="weq-search-more-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索聊天记录"
          autoFocus
        />
        <div className="weq-chatrecords-body">
          <div className="weq-chatrecords-convs">
            {convLoading ? (
              <SearchListSkeleton rows={4} />
            ) : conversations.length === 0 ? (
              <div className="weq-search-empty">无结果</div>
            ) : (
              conversations.map((conv) => (
                <button
                  type="button"
                  key={`${conv.source}:${conv.partition}`}
                  className={`weq-chatrecords-conv ${selected?.partition === conv.partition && selected.source === conv.source ? 'active' : ''}`}
                  onClick={() => setSelected(conv)}
                >
                  <span className="weq-chatrecords-conv-name">{conv.name}</span>
                  <span className="weq-chatrecords-conv-meta">
                    搜索到<strong>{conv.count}</strong>条包含{keyword.trim()}的消息
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="weq-chatrecords-msgs" ref={msgScrollRef} onScroll={onMsgScroll}>
            {msgLoading ? (
              <SearchListSkeleton rows={4} />
            ) : messages.length === 0 ? (
              <div className="weq-search-empty">没有找到相关消息</div>
            ) : (
              <>
                {messages.map((msg) => {
                  const isGroup = selected?.source === 'group';
                  return (
                    <button
                      type="button"
                      key={msg.msgId}
                      className="weq-chatrecords-msg"
                      onClick={() =>
                        selected &&
                        onJumpMessage({
                          source: selected.source,
                          targetUid: selected.targetUid,
                          msgSeq: msg.msgSeq,
                        })
                      }
                    >
                      <img
                        className="weq-chatrecords-msg-avatar"
                        src={
                          isGroup
                            ? (groupAvatarSrc(selected?.targetUid ?? '') ?? undefined)
                            : (c2cAvatarSrc(selected?.targetUin ?? '') ?? undefined)
                        }
                        alt=""
                        loading="lazy"
                      />
                      <span className="weq-chatrecords-msg-text">
                        <span className="weq-chatrecords-msg-meta">
                          {formatTime(msg.sendTime)} · seq {msg.msgSeq}
                        </span>
                        {highlightText(msg.content, keyword.trim())}
                      </span>
                    </button>
                  );
                })}
                {msgLoadingMore ? <SearchListSkeleton rows={2} /> : null}
                {messages.length >= msgTotal && messages.length > 0 ? (
                  <div className="weq-search-more-end">没有更多了</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function formatTime(sendTimeSeconds: string): string {
  const secs = Number(sendTimeSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
