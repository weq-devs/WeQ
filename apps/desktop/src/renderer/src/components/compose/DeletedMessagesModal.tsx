import * as timeFormat from '@weq/time';
import { useMemo, useState, type ReactElement } from 'react';
import { RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { MessageHistorySurface } from '../MessageHistorySurface';
import { MessageHistoryRow } from './MessageHistoryRow';
import { NumericText } from '../NumericText';
import { SegmentedControl } from '../SegmentedControl';
import { deletionIdentity } from '../../lib/messageDeletion';
import { grayTipOf } from '../../im-template/template/messageRow.shared';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { Conversation, Message, User } from '../../im-template/template/types';

/** `''` as the "no filter" sentinel for the two `<select>`s. */
const ALL = '';

/** Delete origin: WeQ deleted it (restorable) vs QQ-native recall (not). */
type DeletedKind = 'weq' | 'qq';

/** Format an ISO message timestamp as a short local date-time. */
function formatMessageTime(iso: string | undefined): string {
  return timeFormat.formatDateTime(iso);
}

/** A deleted message plus the labels/keys the header + filters need. */
type DeletedRow = {
  message: Message;
  kind: DeletedKind;
  restorable: boolean;
  /** Stable key for the original sender (drives the 删除的谁的消息 filter). */
  senderKey: string;
  /** Display label for the original sender. */
  senderLabel: string;
  /** Formatted message send time ('' when unknown). */
  when: string;
};

/** Sort option labels the way a Chinese user reads them (pinyin-ish, stable). */
function byLabel(a: [string, string], b: [string, string]): number {
  return a[1].localeCompare(b[1], 'zh-Hans-CN');
}

export function DeletedMessagesModal({
  conversation,
  user,
  messages,
  hiddenIds,
  loading,
  hasMore = false,
  onLoadMore,
  error,
  onRetry,
  onRestore,
  onLocate,
  onClose,
}: {
  conversation: Conversation;
  user: User;
  /** Deleted messages, newest-first→ASC, already built via messageToTemplate. */
  messages: Message[];
  hiddenIds: ReadonlySet<string>;
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  error: string | null;
  onRetry: () => void;
  /** Restore one message; resolves once the DB row is un-hidden. */
  onRestore: (msgId: string) => Promise<void>;
  onLocate: (seq: string, messageId: string) => void;
  onClose: () => void;
}): ReactElement {
  // Optimistically drop a row the instant its restore resolves, so the panel
  // feels live even before the parent refetches.
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState('');

  const [kindFilter, setKindFilter] = useState<string>(ALL);
  const [senderFilter, setSenderFilter] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  // 灰条是系统通知，不纳入删除索引。
  const visible = useMemo(
    () => messages.filter((m) => !restoredIds.has(m.id) && grayTipOf(m) === null),
    [messages, restoredIds],
  );
  const hiddenKeys = useMemo(() => new Set([...hiddenIds].map(deletionIdentity)), [hiddenIds]);

  // One pass turns each message into a display row (labels + filter keys).
  const rows = useMemo<DeletedRow[]>(
    () =>
      visible.map((message) => {
        const mine = message.senderId === user.id;
        const sender = resolveMessageSender(message, conversation, user);
        const kind = message.deletedKind ?? 'weq';
        return {
          message,
          kind,
          restorable: kind !== 'qq',
          senderKey: message.senderId,
          senderLabel: mine ? '你' : displayUserName(sender),
          when: formatMessageTime(message.createdAt),
        };
      }),
    [visible, conversation, user],
  );

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
          (kindFilter === ALL || row.kind === kindFilter) &&
          (senderFilter === ALL || row.senderKey === senderFilter) &&
          (keyword === '' || row.message.body.toLowerCase().includes(keyword)),
      ),
    [rows, kindFilter, senderFilter, keyword],
  );

  const filtering = kindFilter !== ALL || senderFilter !== ALL || keyword !== '';
  const resetFilters = (): void => {
    setKindFilter(ALL);
    setSenderFilter(ALL);
    setQuery('');
  };

  async function restore(message: Message): Promise<void> {
    if (restoringId) return;
    setRestoringId(message.id);
    setRestoreError('');
    try {
      await onRestore(message.id);
      setRestoredIds((prev) => new Set(prev).add(message.id));
    } catch (reason) {
      setRestoreError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestoringId(null);
    }
  }

  const filters = (
    <div className="weq-msglist-toolbar">
      <label className="weq-msglist-field">
        <span className="weq-msglist-field-label">删除来源</span>
        <SegmentedControl
          label="删除来源"
          value={kindFilter}
          onChange={setKindFilter}
          options={[
            { value: ALL, label: '全部' },
            { value: 'weq', label: 'WeQ 删除', title: 'WeQ 删除可恢复' },
            { value: 'qq', label: 'QQ 删除', title: 'QQ 删除不可恢复' },
          ]}
        />
      </label>

      <label className="weq-msglist-field">
        <span className="weq-msglist-field-label">删除的谁的消息</span>
        <select
          className="weq-msglist-select"
          value={senderFilter}
          onChange={(event) => setSenderFilter(event.target.value)}
          title="只看某个人的消息被删除的记录"
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
          清除筛选
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

  return (
    <MessageHistorySurface
      id="weq-deleted-messages"
      title="已删除消息"
      onClose={onClose}
      filters={filters}
      filtered={filtering}
    >
      {restoreError ? <p role="alert">恢复失败：{restoreError}</p> : null}
      {error ? (
        <p role="alert">
          {error}
          <button className="weq-set-btn weq-retry-button" type="button" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden />
            重试读取
          </button>
        </p>
      ) : null}
      {hasMore && !error ? (
        <button
          type="button"
          className="weq-important-more"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? '正在读取更早消息…' : '加载更早消息'}
        </button>
      ) : null}
      {loading && !rows.length && !hasMore ? (
        <p role="status">正在读取已删除消息…</p>
      ) : !filtered.length && !error ? (
        <p role="status">
          {hasMore
            ? '已加载的记录中没有符合条件的消息'
            : filtering
              ? '没有符合条件的消息'
              : '没有已删除的消息'}
          {filtering ? (
            <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
              清除筛选
            </button>
          ) : null}
        </p>
      ) : filtered.length ? (
        <ul aria-label="已删除消息列表">
          {filtered.map((row) => (
            <MessageHistoryRow
              key={row.message.id}
              icon={<Trash2 size={14} />}
              label={row.senderLabel}
              detail={`${row.restorable ? 'WeQ 删除' : 'QQ 删除'} · ${row.senderLabel}`}
              time={row.when}
              message={row.message}
              onLocate={onLocate}
              unavailableReason={
                hiddenKeys.has(deletionIdentity(row.message.id))
                  ? '消息已隐藏，恢复后可在聊天中查看'
                  : undefined
              }
              action={
                row.restorable ? (
                  <button
                    type="button"
                    className="icon-button"
                    title="恢复这条消息"
                    aria-label="恢复这条消息"
                    aria-busy={restoringId === row.message.id}
                    disabled={restoringId !== null}
                    onClick={() => void restore(row.message)}
                  >
                    <RotateCcw size={14} aria-hidden />
                  </button>
                ) : undefined
              }
            />
          ))}
        </ul>
      ) : null}
    </MessageHistorySurface>
  );
}
