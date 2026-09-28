/**
 * DeletedMessagesModal — the "删除列表": browse the messages WeQ deleted in one
 * conversation and bring any of them back.
 *
 * WeQ's delete mirrors QQ's own recall (40011/40012 → (1,1) in place), so the
 * deleted messages ALSO stay visible in the chat under a translucent overlay —
 * this panel is the centralized management view of the same set.
 *
 * 版式与「撤回列表」(RecalledMessagesModal) 统一：顶部工具栏 + 每条消息一张卡片，
 * 卡片之间以一条细分割线隔开。卡片头 = 删除来源 + 谁的的消息 + 发送时间 + 恢复，
 * 卡片体 = 原消息气泡（同聊天区的 MessageBubble + renderers）。
 *
 * 三处与聊天区不同：
 *   - 灰条系统通知（撤回 / 戳一戳 / 群提示…）被排除 —— 它们不是被删掉的消息；
 *   - 气泡右下角的「已删除 / QQ删除」徽标被抑制（hideDeletedBadge）—— 卡片头已经
 *     说明了状态，那枚徽标只是重复信息；
 *   - 每行多一个「恢复」按钮（删除来源为 QQ 的消息不可恢复，不显示）。
 *
 * 消息对象由调用方 (MainView) 经同一条 `messageToTemplate` 管线构建，所以
 * 发送者 / 头像 / 引用与聊天区一致。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { RotateCcw, Search, Trash2, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext } from '../QqMessageContent';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { grayTipOf } from '../../im-template/template/messageRow';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';

const noop = (): void => {};

/** `''` as the "no filter" sentinel for the two `<select>`s. */
const ALL = '';

/** Delete origin: WeQ deleted it (restorable) vs QQ-native recall (not). */
type DeletedKind = 'weq' | 'qq';

/** Format an ISO message timestamp as a short local date-time. */
function formatMessageTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A deleted message plus the labels/keys the header + filters need. */
type DeletedRow = {
  message: Message;
  mine: boolean;
  sender: User;
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
  renderers,
  loading,
  onRestore,
  onClose,
}: {
  conversation: Conversation;
  user: User;
  /** Deleted messages, newest-first→ASC, already built via messageToTemplate. */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  /** Restore one message; resolves once the DB row is un-hidden. */
  onRestore: (msgId: string) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  // Optimistically drop a row the instant its restore resolves, so the panel
  // feels live even before the parent refetches.
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [kindFilter, setKindFilter] = useState<string>(ALL);
  const [senderFilter, setSenderFilter] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  // 灰条（撤回 / 戳一戳 / 群提示…）是系统通知，不是「被删掉的消息」：在这份列表里
  // 没有恢复的意义，套气泡画出来也难看，直接排除。
  const visible = useMemo(
    () => messages.filter((m) => !restoredIds.has(m.id) && grayTipOf(m) === null),
    [messages, restoredIds],
  );

  // One pass turns each message into a display row (labels + filter keys).
  const rows = useMemo<DeletedRow[]>(
    () =>
      visible.map((message) => {
        const mine = message.senderId === user.id;
        const sender = resolveMessageSender(message, conversation, user);
        const kind = (message as { deletedKind?: DeletedKind }).deletedKind ?? 'weq';
        return {
          message,
          mine,
          sender,
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
    try {
      await onRestore(message.id);
      setRestoredIds((prev) => new Set(prev).add(message.id));
    } catch {
      /* leave the row in place on failure; parent surfaces the error */
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Modal onClose={onClose} width={560} labelledBy="weq-deleted-title">
      <div className="weq-deleted">
        <header className="weq-compose-head">
          <div className="weq-compose-titlewrap">
            <strong id="weq-deleted-title" className="weq-compose-title">
              删除列表
            </strong>
            <span className="weq-compose-sub">{subtitle}</span>
          </div>
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        {/* 筛选 + 搜索：删除来源 / 被删除者两个下拉，外加消息正文搜索。 */}
        <div className="weq-msglist-toolbar">
          <label className="weq-msglist-field">
            <span className="weq-msglist-field-label">删除来源</span>
            <select
              className="weq-msglist-select"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
              title="WeQ 删除可恢复；QQ 删除（本体撤回/他端删除）不可恢复"
            >
              <option value={ALL}>全部</option>
              <option value="weq">WeQ删除</option>
              <option value="qq">QQ删除</option>
            </select>
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
              value={query}
              placeholder="搜索消息内容…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {filtering ? (
            <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
              重置
            </button>
          ) : null}

          <span className="weq-msglist-count">
            {filtering ? `${filtered.length} / ${rows.length} 条` : `共 ${rows.length} 条`}
          </span>
        </div>

        <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
          <ConvContext.Provider value={convKey}>
            <div className={cn('message-scroll', 'weq-deleted-scroll')}>
              {loading ? (
                <div className="weq-deleted-empty">加载中…</div>
              ) : rows.length === 0 ? (
                <div className="weq-deleted-empty">
                  <Trash2 size={26} />
                  <span>没有已删除的消息</span>
                  <small>
                    在聊天里右键消息「删除」后，消息会以半透明样式留在原位，也会出现在这里，可随时恢复。对方撤回
                    / 在其他设备删除的消息也会出现在这里（标记为「QQ删除」，无法恢复）。
                  </small>
                </div>
              ) : filtered.length === 0 ? (
                <div className="weq-deleted-empty">
                  <Search size={26} />
                  <span>没有符合条件的消息</span>
                  <button type="button" className="weq-msglist-reset" onClick={resetFilters}>
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className="weq-msglist-list">
                  {filtered.map((row) => (
                    <article
                      key={row.message.id}
                      className={cn('weq-msglist-item', row.mine && 'is-mine')}
                    >
                      <div className="weq-msglist-meta">
                        <span
                          className={cn('weq-msglist-kind', row.kind === 'qq' && 'is-qq')}
                          title={
                            row.restorable ? 'WeQ 删除，可随时恢复' : 'QQ 本体删除/撤回，无法恢复'
                          }
                        >
                          {row.restorable ? 'WeQ删除' : 'QQ删除'}
                        </span>
                        <span className="weq-msglist-line">{row.senderLabel} 的消息</span>
                        {row.when ? (
                          <time className="weq-msglist-time" title="消息发送时间">
                            {row.when}
                          </time>
                        ) : null}
                        {row.restorable ? (
                          <button
                            type="button"
                            className="weq-msglist-restore"
                            title="恢复这条消息"
                            disabled={restoringId === row.message.id}
                            onClick={() => void restore(row.message)}
                          >
                            <RotateCcw size={13} />
                            <span>{restoringId === row.message.id ? '恢复中…' : '恢复'}</span>
                          </button>
                        ) : null}
                      </div>
                      <div className="weq-deleted-bubble">
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
                          deletedKind={row.kind}
                          // 卡片头的「WeQ删除 / QQ删除」徽标已把这层含义讲清楚，
                          // 气泡右下角那枚小标签是重复信息，去掉。
                          hideDeletedBadge
                          onContextMenu={noop}
                          onLongPress={noop}
                        />
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </div>
    </Modal>
  );
}
