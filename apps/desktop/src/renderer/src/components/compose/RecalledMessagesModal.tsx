import { NumericText } from '../NumericText';
import * as timeFormat from '@weq/time';
/**
 * RecalledMessagesModal — the "撤回列表": browse the messages that were recalled
 * in one conversation while anti-recall was protecting it.
 *
 * Unlike deletes, a recalled message's original content is NOT hidden: the
 * anti-recall SQL trigger cancels QQ's recall in place, so the real row survives
 * and renders normally. This panel is the centralized view of everything the
 * trigger caught.
 *
 * 会话内使用紧凑索引，设置中的撤回记录保留原来的完整消息列表。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { LoadingIndicator } from '../LoadingIndicator';
import { CornerUpRight, RotateCcw, Search, RefreshCw } from 'lucide-react';
import { MessageHistorySurface } from '../MessageHistorySurface';
import { MessageHistoryRow } from './MessageHistoryRow';
import { ConvContext, ForwardKindContext } from '../../state/messageContext';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';
import { useToast } from '../Toast.shared';

const noop = (): void => {};

/** `''` as the "no filter" sentinel for the two `<select>`s. */
const ALL = '';

/** Recall marker carried by a recalled message (mirrors the service's RecallInfo). */
type RecallInfo = { revokeUid: string; sameSender: boolean; recallTs: number };

/** Format a unix-second recall timestamp as a short local date-time. */
function formatRecallTime(ts: number): string {
  return ts > 0 ? timeFormat.formatUnixTime(ts) : '';
}

/** A recalled message plus the labels/keys the header + filters need. */
type RecallRow = {
  message: Message;
  mine: boolean;
  sender: User;
  /** Stable key for the revoker (drives the 撤回者 filter). */
  revokerKey: string;
  /** Display label for the revoker. */
  revokerLabel: string;
  /** Stable key for the original sender (drives the 被撤回者 filter). */
  senderKey: string;
  /** Display label for the original sender. */
  senderLabel: string;
  /** Header sentence: who recalled whose message. */
  recallLine: string;
  /** Formatted recall time ('' when unknown). */
  when: string;
};

/** Sort option labels the way a Chinese user reads them (pinyin-ish, stable). */
function byLabel(a: [string, string], b: [string, string]): number {
  return a[1].localeCompare(b[1], 'zh-Hans-CN');
}

export function RecalledMessagesModal({
  conversation,
  user,
  messages,
  renderers,
  loading,
  hasMore = false,
  onLoadMore,
  onClose,
  onJumpToMessage,
  embedded = false,
  error,
  onRetry,
}: {
  conversation: Conversation;
  user: User;
  /** Recalled messages, newest-recall-first, already built via messageToTemplate. */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onClose: () => void;
  onJumpToMessage?: (seq: string, messageId: string) => void;
  /** 设置工具已有唯一模态容器，只复用内容，不再叠加第二个窗口。 */
  embedded?: boolean;
  error?: string | null;
  onRetry?: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  const [revokerFilter, setRevokerFilter] = useState<string>(ALL);
  const [senderFilter, setSenderFilter] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  // One pass turns each message into a display row (labels + filter keys), so the
  // render body and both option lists stay trivial.
  const rows = useMemo<RecallRow[]>(
    () =>
      messages.map((message) => {
        const mine = message.senderId === user.id;
        const sender = resolveMessageSender(message, conversation, user);
        const recall = (message as { recall?: RecallInfo }).recall;
        const revokerName = (message as { recallRevokerName?: string }).recallRevokerName;
        const senderLabel = mine ? '你' : displayUserName(sender);
        const revokerLabel = !recall
          ? '未知'
          : recall.sameSender
            ? senderLabel
            : revokerName?.trim() || '管理员';
        const revokerKey = !recall
          ? 'unknown'
          : recall.sameSender
            ? `sender:${message.senderId}`
            : `revoker:${recall.revokeUid || revokerLabel}`;
        const recallLine = !recall
          ? '这条消息曾被撤回'
          : recall.sameSender
            ? `${revokerLabel} 撤回了自己的消息`
            : `${revokerLabel} 撤回了 ${senderLabel} 的消息`;
        return {
          message,
          mine,
          sender,
          revokerKey,
          revokerLabel,
          senderKey: message.senderId,
          senderLabel,
          recallLine,
          when: recall ? formatRecallTime(recall.recallTs) : '',
        };
      }),
    [messages, conversation, user],
  );

  const revokerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.revokerKey, row.revokerLabel);
    return [...map.entries()].sort(byLabel);
  }, [rows]);

  const senderOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.senderKey, row.senderLabel);
    return [...map.entries()].sort(byLabel);
  }, [rows]);

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          (revokerFilter === ALL || row.revokerKey === revokerFilter) &&
          (senderFilter === ALL || row.senderKey === senderFilter) &&
          (keyword === '' || row.message.body.toLowerCase().includes(keyword)),
      ),
    [rows, revokerFilter, senderFilter, keyword],
  );

  const filtering = revokerFilter !== ALL || senderFilter !== ALL || keyword !== '';
  const resetFilters = (): void => {
    setRevokerFilter(ALL);
    setSenderFilter(ALL);
    setQuery('');
  };

  const handleClickMessage = (message: Message): void => {
    if (!onJumpToMessage) {
      return;
    }

    const { msgSeq } = message;
    if (!msgSeq || !/^[1-9]\d*$/.test(msgSeq)) {
      pushToast({
        tone: 'info',
        durationKind: 'success',
        title: '未找到该消息',
        detail: '该消息可能已被撤回或删除，无法跳转定位。',
      });
      return;
    }

    onJumpToMessage(msgSeq, message.id);
  };

  const filters = (
    <div className="weq-msglist-toolbar">
      <label className="weq-msglist-field">
        <span className="weq-msglist-field-label">撤回者</span>
        <select
          className="weq-msglist-select"
          value={revokerFilter}
          onChange={(event) => setRevokerFilter(event.target.value)}
          title="只看某个人撤回的消息"
        >
          <option value={ALL}>全部</option>
          {revokerOptions.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="weq-msglist-field">
        <span className="weq-msglist-field-label">被撤回者</span>
        <select
          className="weq-msglist-select"
          value={senderFilter}
          onChange={(event) => setSenderFilter(event.target.value)}
          title="只看某个人的消息被撤回的记录"
        >
          <option value={ALL}>全部</option>
          {senderOptions.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="weq-msglist-search">
        <Search size={14} />
        <input
          className="weq-msglist-search-input"
          type="search"
          aria-label="搜索消息内容"
          value={query}
          placeholder="搜索消息内容…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {filtering ? (
        <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
          {embedded ? '重置' : '清除筛选'}
        </button>
      ) : null}

      <span className="weq-msglist-count">
        {filtering ? (
          <NumericText>{`${filtered.length} / ${rows.length} 条`}</NumericText>
        ) : (
          <NumericText>{`${hasMore ? '已加载' : '共'} ${rows.length} 条`}</NumericText>
        )}
      </span>
    </div>
  );

  const renderBubble = (row: RecallRow) => (
    <MessageBubble
      message={row.message}
      conversation={conversation}
      sender={row.sender}
      mine={row.mine}
      senderName={displayUserName(row.sender)}
      senderAvatarUrl={row.sender.avatarUrl}
      senderSeed={row.sender.identityValue}
      senderKind={row.sender.kind}
      showSenderName={showSenderNames}
      active={false}
      renderers={renderers}
      recallRevokerName={row.revokerLabel}
      hideRecallTag
      onContextMenu={noop}
      onLongPress={noop}
    />
  );

  const retry = onRetry ? (
    <button className="weq-set-btn weq-retry-button" type="button" onClick={onRetry}>
      <RefreshCw size={14} aria-hidden />
      重试读取
    </button>
  ) : null;
  const more =
    hasMore && !error ? (
      <button type="button" className="weq-important-more" disabled={loading} onClick={onLoadMore}>
        {loading ? '正在读取更早消息…' : '加载更早消息'}
      </button>
    ) : null;
  const initialLoading = loading && !rows.length && !hasMore;
  const emptyLabel = hasMore
    ? '已加载的记录中没有符合条件的消息'
    : filtering
      ? '没有符合条件的消息'
      : '没有被撤回的消息';

  if (!embedded) {
    return (
      <MessageHistorySurface
        id="weq-recalled-messages"
        title="已撤回消息"
        onClose={onClose}
        filters={filters}
        filtered={filtering}
      >
        {error ? (
          <p role="alert">
            {error}
            {retry}
          </p>
        ) : null}
        {more}
        {initialLoading ? (
          <p role="status">正在读取已撤回消息…</p>
        ) : !filtered.length && !error ? (
          <p role="status">
            {emptyLabel}
            {filtering ? (
              <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
                清除筛选
              </button>
            ) : null}
          </p>
        ) : filtered.length ? (
          <ul aria-label="已撤回消息列表">
            {filtered.map((row) => (
              <MessageHistoryRow
                key={row.message.id}
                icon={<RotateCcw size={14} />}
                label={row.senderLabel}
                detail={row.recallLine}
                time={row.when}
                message={row.message}
                onLocate={onJumpToMessage}
              />
            ))}
          </ul>
        ) : null}
      </MessageHistorySurface>
    );
  }

  return (
    <div className="weq-deleted weq-recalled is-embedded">
      <p className="weq-recalled-subtitle">{subtitle}</p>
      {filters}
      <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
        <ConvContext.Provider value={convKey}>
          <div className={cn('message-scroll', 'weq-deleted-scroll')}>
            {error ? (
              <div className="weq-deleted-empty" role="alert">
                <span>{error}</span>
                {retry}
              </div>
            ) : null}
            {initialLoading ? (
              <div className="weq-deleted-empty" role="status">
                <LoadingIndicator />
              </div>
            ) : rows.length === 0 && !hasMore && !error ? (
              <div className="weq-deleted-empty">
                <RotateCcw size={26} />
                <span>没有被撤回的消息</span>
                <small>
                  开启防撤回后，对方撤回的消息会被拦截并保留在原位，也会出现在这里，标注撤回者与时间。
                </small>
              </div>
            ) : filtered.length === 0 && !error ? (
              <div className="weq-deleted-empty">
                <Search size={26} />
                <span>{emptyLabel}</span>
                {filtering ? (
                  <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
                    清除筛选
                  </button>
                ) : null}
              </div>
            ) : filtered.length ? (
              <div className="weq-msglist-list">
                {filtered.map((row) => (
                  <article
                    key={row.message.id}
                    className={cn(
                      'weq-msglist-item',
                      row.mine && 'is-mine',
                      onJumpToMessage && 'is-clickable',
                    )}
                    onClick={() => onJumpToMessage && handleClickMessage(row.message)}
                    role={onJumpToMessage ? 'button' : undefined}
                    tabIndex={onJumpToMessage ? 0 : undefined}
                    onKeyDown={(event) => {
                      if (onJumpToMessage && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        handleClickMessage(row.message);
                      }
                    }}
                    title={onJumpToMessage ? '点击跳转到该消息' : undefined}
                  >
                    <div className="weq-msglist-meta">
                      <span className="weq-msglist-badge" aria-hidden>
                        <RotateCcw size={12} />
                      </span>
                      <span className="weq-msglist-line">{row.recallLine}</span>
                      {row.when ? <time className="weq-msglist-time">{row.when}</time> : null}
                      {onJumpToMessage ? (
                        <span className="weq-msglist-jump">
                          <CornerUpRight size={12} />
                          <span>跳转</span>
                        </span>
                      ) : null}
                    </div>
                    <div className="weq-deleted-bubble">{renderBubble(row)}</div>
                  </article>
                ))}
              </div>
            ) : null}
            {more}
          </div>
        </ConvContext.Provider>
      </ForwardKindContext.Provider>
    </div>
  );
}
