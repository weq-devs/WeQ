import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, RotateCw } from 'lucide-react';
import { client } from '../trpc/client';
import { ChatPane } from '../im-template/template/chatPane';
import type { Conversation, Message, User } from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import { qqMessageRenderer, ConvContext } from './QqMessageContent';
import { Modal } from './Dialog';
import { plainContentText } from '@weq/service/message-plain-text';
import { usePageDataCache } from './PageSnapshots';
import { accountBinding } from '../lib/clientPreferences';
import { unixDate } from '@weq/time';
import type { MessageBubbleSkin } from '@weq/service';
import { seedMessageBubbles, messageBubble } from '../lib/messageBubbles';

export type ReadonlyTarget =
  | { kind: 'official'; peerUid: string }
  | { kind: 'service'; appId: string }
  | { kind: 'guild'; nodeId: string };
interface Cursor {
  msgSeq: string;
  sendTime: string;
  msgId: string;
}
interface Wire {
  cachedBubbles?: MessageBubbleSkin[];
  msgId: string;
  msgSeq: string;
  sendTime: string;
  sendType?: string;
  senderUid?: string;
  senderUin?: string;
  elements?: unknown[];
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}
const renderersDefault = [qqMessageRenderer];
const emptyDraft = () => {};
const noSend = async () => {
  throw new Error('此来源暂不支持发送消息');
};
const content = (elements?: unknown[]) =>
  plainContentText(
    elements?.filter((element): element is { type: string } =>
      Boolean(
        element &&
          typeof element === 'object' &&
          'type' in element &&
          typeof element.type === 'string',
      ),
    ),
  );

export function ReadonlyConversationPane({
  target,
  conversation,
  user,
  renderers = renderersDefault,
  anchorId,
  onBack,
  sourceDetails = [],
  onEditMessage,
}: {
  target: ReadonlyTarget;
  conversation: Conversation;
  user: User;
  renderers?: MessageRenderer[];
  anchorId?: string;
  onBack: () => void;
  sourceDetails?: Array<{ label: string; value: string }>;
  onEditMessage?: (id: string) => void;
}) {
  const cache = usePageDataCache();
  const binding = accountBinding() ?? { expectedAccountUin: user.identityValue };
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const key = JSON.stringify([user.id, binding, target]);
  const request = useRef(0);
  const lastRequest = useRef({ older: false, anchor: anchorId, newer: false });
  const latest = useRef({
    key,
    cursor: null as Cursor | null,
    newerCursor: null as Cursor | null,
    loading: false,
  });
  const [rows, setRows] = useState<Wire[]>(() => cache.read<Wire[]>(`readonly:${key}`) ?? []);
  const [hasPage, setHasPage] = useState(() => cache.read<Wire[]>(`readonly:${key}`) !== undefined);
  const [loading, setLoading] = useState(() => cache.read<Wire[]>(`readonly:${key}`) === undefined);
  const [loadKind, setLoadKind] = useState<'page' | 'older' | 'newer' | 'locate'>('page');
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [atLatest, setAtLatest] = useState(!anchorId);
  const [profile, setProfile] = useState(false);
  const [search, setSearch] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [hits, setHits] = useState<Wire[]>([]);
  const [searchMore, setSearchMore] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchTerm = useRef('');
  const [jump, setJump] = useState<{ messageId: string; revision: number }>();
  const searchVersion = useRef(0);
  latest.current.key = key;
  const fetchPage = useCallback(
    async (older = false, anchor?: string, newer = false) => {
      if ((older || newer) && latest.current.loading) return false;
      if (newer && !latest.current.newerCursor) return false;
      lastRequest.current = { older, anchor, newer };
      const version = ++request.current;
      latest.current.loading = true;
      setLoading(true);
      setLoadKind(anchor ? 'locate' : older ? 'older' : newer ? 'newer' : 'page');
      setError('');
      try {
        let items: Wire[];
        let more: boolean;
        let cursor: Cursor | null;
        if (target.kind === 'guild') {
          if (anchor) {
            const result = await client.account.guildDirectAround.query({
              nodeId: target.nodeId,
              msgId: anchor,
              msgSeq: '0',
            });
            items = result.items.slice().reverse();
          } else
            items =
              newer && latest.current.newerCursor
                ? await client.account.guildDirectAfter.query({
                    nodeId: target.nodeId,
                    cursor: latest.current.newerCursor,
                    limit: 50,
                  })
                : older && latest.current.cursor
                  ? await client.account.guildDirectBefore.query({
                      nodeId: target.nodeId,
                      beforeSeq: latest.current.cursor.msgSeq,
                      beforeMsgId: latest.current.cursor.msgId,
                      limit: 50,
                    })
                  : await client.account.guildDirectLatest.query({
                      nodeId: target.nodeId,
                      stablePaging: true,
                      limit: 50,
                    });
          more = items.length >= 50 || Boolean(anchor);
          const last = items.at(-1);
          cursor = last
            ? { msgId: last.msgId, msgSeq: last.msgSeq, sendTime: last.sendTime }
            : null;
        } else {
          const result = await client.account.readonlyConversationPage.query({
            ...bindingRef.current,
            target,
            direction: newer ? 'newer' : 'older',
            cursor: newer
              ? (latest.current.newerCursor ?? undefined)
              : older
                ? (latest.current.cursor ?? undefined)
                : undefined,
            anchorId: anchor,
            limit: 50,
          });
          items = result.items;
          more = result.hasMore;
          cursor = result.nextCursor;
          if (!result.found) throw new Error('该条记录已不在当前会话中');
        }
        if (version !== request.current || latest.current.key !== key) return false;
        if (!newer) latest.current.cursor = cursor;
        const newest = items[0];
        if (!older && newest)
          latest.current.newerCursor = {
            msgId: newest.msgId,
            msgSeq: newest.msgSeq,
            sendTime: newest.sendTime,
          };
        setRows((current) => {
          const next = older
            ? [...items.reverse(), ...current]
            : newer
              ? [...current, ...items.reverse()]
              : items.reverse();
          const unique = [...new Map(next.map((row) => [row.msgId, row])).values()];
          if (!anchor && !older && !newer) cache.write(`readonly:${key}`, unique);
          return unique;
        });
        setHasPage(true);
        if (!newer) setHasMore(more);
        if (newer) setAtLatest(!more);
        else if (!older) setAtLatest(!anchor);
        if (anchor) setJump({ messageId: anchor, revision: version });
        return true;
      } catch (reason) {
        if (version === request.current)
          setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      } finally {
        if (version === request.current) {
          latest.current.loading = false;
          setLoading(false);
        }
      }
    },
    [key, target, cache],
  );
  useEffect(() => {
    const cached = cache.read<Wire[]>(`readonly:${key}`);
    setRows(cached ?? []);
    setHasPage(cached !== undefined);
    setSearch(false);
    setSearched(false);
    setSearching(false);
    setHits([]);
    setSearchMore(false);
    setSearchError('');
    searchVersion.current++;
    void fetchPage(false, anchorId);
    return () => {
      request.current++;
      latest.current.loading = false;
    };
  }, [key, anchorId, cache, fetchPage]);
  const messages = useMemo<Message[]>(() => {
    for (const row of rows) seedMessageBubbles(row.cachedBubbles);
    return rows.map((row) => {
      const mine =
        target.kind === 'guild'
          ? row.sendType !== '0'
          : Boolean(row.senderUid && (row.senderUid === user.uid || row.senderUid === user.id)) ||
            Boolean(row.senderUin && row.senderUin === user.identityValue);
      const peer = conversation.type === 'direct' ? conversation.otherUser : user;
      return {
        id: row.msgId,
        msgId: row.msgId,
        msgSeq: row.msgSeq,
        conversationId: conversation.id,
        body: content(row.elements),
        senderId: mine ? user.id : peer.id,
        sender: mine ? user : peer,
        createdAt: unixDate(row.sendTime)?.toISOString() ?? new Date(0).toISOString(),
        qqElements: row.elements as Message['qqElements'],
        decoration: row.decoration
          ? { ...row.decoration, cachedBubble: messageBubble(row.decoration.bubbleId) }
          : undefined,
      };
    });
  }, [rows, target.kind, conversation, user]);
  const find = async (append = false) => {
    const term = append ? searchTerm.current : keyword.trim();
    if (!term) return;
    if (!append) {
      searchTerm.current = term;
      setHits([]);
      setSearchMore(false);
    }
    const revision = ++searchVersion.current;
    setSearching(true);
    setSearched(true);
    setSearchError('');
    try {
      const result = await client.account.searchReadonlyConversation.query({
        ...bindingRef.current,
        target,
        keyword: term,
        offset: append ? hits.length : 0,
        limit: 30,
      });
      if (revision !== searchVersion.current || key !== latest.current.key) return;
      setHits((current) => (append ? [...current, ...result.items] : result.items));
      setSearchMore(result.hasMore);
    } catch (reason) {
      if (revision === searchVersion.current) setSearchError(String(reason));
    } finally {
      if (revision === searchVersion.current) setSearching(false);
    }
  };
  return (
    <ConvContext.Provider value={target.kind === 'official' ? target.peerUid : ''}>
      <ChatPane
        user={user}
        conversation={conversation}
        messages={messages}
        messageRenderers={renderers}
        loading={loading && !hasPage && !rows.length}
        loadingOlder={loading && loadKind === 'older'}
        loadingNewer={loading && loadKind === 'newer'}
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
        hasOlder={hasMore}
        onLoadOlder={() => fetchPage(true).then(() => {})}
        atLatest={atLatest}
        onLoadNewer={() => fetchPage(false, undefined, true).then(() => {})}
        onJumpToLatest={() => fetchPage()}
        jumpRequest={jump}
        onOpenSourceProfile={() => setProfile(true)}
        onSearchChatRecords={() => setSearch(true)}
        onEditRaw={onEditMessage ? (message) => onEditMessage(message.id) : undefined}
        timelineNotice={
          error ? (
            <button
              type="button"
              className="icon-button"
              aria-label="重新读取消息"
              title="重新读取消息"
              onClick={() => {
                const failed = lastRequest.current;
                void fetchPage(failed.older, failed.anchor, failed.newer);
              }}
            >
              <RotateCw size={16} />
            </button>
          ) : null
        }
      />
      {profile ? (
        <Modal onClose={() => setProfile(false)} title="会话资料">
          <dl className="weq-conversation-notice">
            {[
              {
                label: '名称',
                value: conversation.type === 'direct' ? conversation.otherUser.displayName : '',
              },
              ...sourceDetails,
            ].map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value || '暂无资料'}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      ) : null}
      {search ? (
        <Modal
          title="搜索聊天记录"
          onClose={() => {
            searchVersion.current++;
            setSearch(false);
            setSearching(false);
            if (searching) setSearched(false);
          }}
        >
          <form
            className="weq-conversation-notice"
            onSubmit={(event) => {
              event.preventDefault();
              if (keyword.trim()) void find();
            }}
          >
            <input
              aria-label="搜索聊天记录"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button
              type="submit"
              className="icon-button"
              title="搜索"
              aria-label="搜索"
              disabled={searching || !keyword.trim()}
            >
              <Search size={16} />
            </button>
          </form>
          {searchError ? <p role="alert">{searchError}</p> : null}
          {hits.map((hit) => (
            <button
              key={hit.msgId}
              type="button"
              className="weq-search-result"
              onClick={() => {
                setSearch(false);
                void fetchPage(false, hit.msgId);
              }}
            >
              {content(hit.elements) || '[消息]'}
            </button>
          ))}
          {searchMore ? (
            <button type="button" disabled={searching} onClick={() => void find(true)}>
              加载更多
            </button>
          ) : null}
          {searching ? <p role="status">正在搜索本地记录…</p> : null}
          {searched && !searching && !searchError && !hits.length ? (
            <p role="status">未找到匹配消息</p>
          ) : null}
        </Modal>
      ) : null}
    </ConvContext.Provider>
  );
}
