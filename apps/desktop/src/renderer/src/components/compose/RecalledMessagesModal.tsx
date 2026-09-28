/**
 * RecalledMessagesModal — the "撤回列表": browse the messages that were recalled
 * in one conversation while anti-recall was protecting it.
 *
 * Unlike deletes, a recalled message's original content is NOT hidden: the
 * anti-recall SQL trigger cancels QQ's recall in place, so the real row survives
 * and renders normally. This panel is the centralized view of everything the
 * trigger caught.
 *
 * 版式（重构后）：每条撤回消息 = 一张卡片，卡片之间用一条细分割线隔开。
 *   ┌ 撤回信息头（撤回者 · 撤回时间 · 跳转提示）
 *   └ 原消息气泡
 * 气泡自带的 `.weq-msg-recall-tag` 被抑制（`hideRecallTag`）—— 撤回信息统一由卡片头
 * 承载，不再「气泡下面一个、气泡右边一个」地碎成一堆、还可能互相重叠。
 *
 * 顶部工具栏支持按「谁撤回的 / 撤回的谁的」筛选，以及按消息正文搜索。行由调用方
 * (MainView) 经同一条 `messageToTemplate` 管线构建，所以发送者/头像/引用与聊天区一致。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { CornerUpRight, RotateCcw, Search, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext } from '../QqMessageContent';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';
import { useToast } from '../Toast';

const noop = (): void => {};

/** `''` as the "no filter" sentinel for the two `<select>`s. */
const ALL = '';

/** Recall marker carried by a recalled message (mirrors the service's RecallInfo). */
type RecallInfo = { revokeUid: string; sameSender: boolean; recallTs: number };

/** Format a unix-second recall timestamp as a short local date-time. */
function formatRecallTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  onClose,
  onJumpToMessage,
}: {
  conversation: Conversation;
  user: User;
  /** Recalled messages, newest-recall-first, already built via messageToTemplate. */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  onClose: () => void;
  /** 跳转到指定 seq 的消息（参考精华消息的实现）*/
  onJumpToMessage?: (seq: number | string) => void;
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

    // 从 message 中提取 msgSeq (group) 或 msgIndex (c2c)
    const msgSeq = (message as { msgSeq?: string | number }).msgSeq;

    if (msgSeq == null || msgSeq === '') {
      pushToast({
        tone: 'info',
        title: '未找到该消息',
        detail: '该消息可能已被撤回或删除，无法跳转定位。',
      });
      return;
    }

    onClose();
    onJumpToMessage(msgSeq);
  };

  return (
    <Modal onClose={onClose} width={560} labelledBy="weq-msglist-title">
      <div className={cn('weq-deleted', 'weq-recalled')}>
        <header className="weq-compose-head">
          <div className="weq-compose-titlewrap">
            <strong id="weq-msglist-title" className="weq-compose-title">
              撤回列表
            </strong>
            <span className="weq-compose-sub">{subtitle}</span>
          </div>
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        {/* 筛选 + 搜索：撤回者 / 被撤回者两个下拉，外加消息正文搜索。 */}
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
                  <RotateCcw size={26} />
                  <span>没有被撤回的消息</span>
                  <small>
                    开启防撤回后，对方撤回的消息会被拦截并保留在原位，也会出现在这里，标注撤回者与时间。
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
                          recallRevokerName={row.revokerLabel}
                          hideRecallTag
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
