/**
 * GapMessagesModal — 「缺失消息」弹窗：聊天时间线里 QQ 从未同步到本机的消息。
 *
 * 占位条（MessageGapDivider）点击后由宿主通过
 * `account.fetchGapMessages` 按 seq 窗口从 QQ 服务端拉取，再像普通消息一样
 * 完整渲染（头像 / 昵称 / 装扮 / 消息体）。渲染管线与撤回列表一致：直接复用
 * 主时间线的 MessageRow（灰条分流 / 气泡）与 renderers。
 *
 * 状态机：
 *   - loading     拉取中（首屏）
 *   - error       拉取失败（漫游未开 / 消息过期 / 其它），整窗显示错误文案
 *   - messages    拉取成功，逐条渲染。缺口超过 30 条时分页：首屏拿最旧一段
 *                 垫底，列表按 seq 升序（旧在上、新在下）；滚动到底（底部哨
 *                 兵进入视口）触发 onLoadMore 拉更新的一段 append 到尾部，
 *                 直到 hasMore 为 false。
 *
 * 群成员身份由宿主按需回填。引用先定位已加载的原消息，再按宿主提供的会话入口定位。
 */

import { GAP_MESSAGES_WIDTH } from './GapMessagesModal.shared';
import { NumericText } from '../NumericText';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import '../../styles/private-preview.css';
import { ArrowLeft, CloudOff, RefreshCw, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { MemberProfileCard } from '../MemberProfileCard';
import { ChatMediaGallery } from '../ChatMediaGallery';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import { ConvContext, ForwardKindContext, ReplyJumpContext } from '../../state/messageContext';
import { cn } from '../../im-template/template/classNames';
import { MessageRow } from '../../im-template/template/messageRow';
import { MessageTimeDivider } from '../../im-template/template/messageTime';
import { shouldShowMessageTime } from '../../im-template/template/messageTime.shared';
import {
  messageGroups,
  messageTimelineSpacing,
} from '../../im-template/template/chatTimelineModel';
import { messageGapCount } from '../../im-template/template/messageGap.shared';
import { grayTipOf } from '../../im-template/template/messageRow.shared';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';
import type { ReplyJumpTarget } from '../../state/messageContext';
import { useReadonlyMessageMenu } from '../../hooks/useReadonlyMessageMenu';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { readonlyConversationKind } from '../../lib/conversationActions';
import { deletionIdentity, hiddenDeletionLookup } from '../../lib/messageDeletion';
import { preferenceValue, useClientPreferences } from '../../lib/clientPreferences';
import { findReplySource } from '../../lib/replyPreview';
import {
  messageElement,
  revealTimelineMessage,
  TIMELINE_MESSAGE_SELECTOR,
} from '../../lib/timelineViewport';
import { loadHiddenMessageIds } from '../../im-template/template/hiddenMessages';

function captureReadingAnchor(scroll: HTMLElement, first?: string) {
  const top = scroll.getBoundingClientRect().top;
  const row = [...scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)].find(
    (row) => row.getBoundingClientRect().bottom > top,
  );
  return {
    height: scroll.scrollHeight,
    first,
    id: row?.dataset.messageId,
    top: row?.getBoundingClientRect().top,
  };
}

export function GapMessagesModal({
  conversation,
  user,
  detailsBinding,
  messages,
  renderers,
  loading,
  loadingMore,
  error,
  hasMore,
  moreFailed,
  totalCount,
  notice,
  onLoadMore,
  onClose,
  preview = false,
  embedded = false,
  onRetry,
  title,
  backLabel = '返回资料',
  messageNotice,
  onLocateMessage,
  onLocateReply,
  showSenderProfiles = true,
  independent = !preview,
  deletedIds,
  hiddenIds,
}: {
  conversation: Conversation;
  user: User;
  detailsBinding?: QQWriteBinding | null;
  /** 已通过 messageToTemplate 构建好的模板消息（与主时间线同一管线）；seq 升序，旧在上、新在下。 */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  /** 滚动到顶后正在拉取更旧的一页。 */
  loadingMore: boolean;
  /** 拉取失败文案；非空且未在加载时整窗展示。 */
  error: string | null;
  /** 缺口还有更旧的一页可拉。 */
  hasMore: boolean;
  /** 拉取更多失败：哨兵停止自动触发，显示重试按钮。 */
  moreFailed: boolean;
  /** 缺口总条数（占位条估算），用于底部进度文案。 */
  totalCount: number;
  notice?: string;
  onLoadMore: () => void;
  onClose: () => void;
  preview?: boolean;
  /** 名片内预览复用消息列表，不创建额外浮窗。 */
  embedded?: boolean;
  onRetry?: () => void;
  title?: string;
  backLabel?: string;
  /** 只读预览中逐条展示的附注，例如跳过发送的原因。 */
  messageNotice?: (message: Message) => string | undefined;
  onLocateMessage?: (target: ReplyJumpTarget) => void | Promise<void>;
  onLocateReply?: (target: ReplyJumpTarget) => boolean | Promise<boolean>;
  showSenderProfiles?: boolean;
  /** 仅看某个成员、缺少可靠会话位置等选区逐条展示作者与时间。 */
  independent?: boolean;
  deletedIds?: ReadonlySet<string>;
  hiddenIds?: ReadonlySet<string>;
}): ReactElement {
  const [replyError, setReplyError] = useState('');
  const menu = useReadonlyMessageMenu({
    conversation,
    user,
    detailsBinding,
    scope: `${user.id}:${detailsBinding?.expectedAccountConfigId}:${conversation.id}:${independent}`,
    enterOpensMenu: true,
    onLocate:
      onLocateMessage &&
      ((message) =>
        onLocateMessage({
          seq: message.msgSeq,
          msgId: message.id,
        })),
  });
  const openChat = useContext(ChatNavigationContext);
  const [memberCard, setMemberCard] = useState<{
    member: User;
    anchor: { x: number; y: number };
  } | null>(null);
  const openMember = useCallback((member: User, anchor: { x: number; y: number }) => {
    setMemberCard({ member, anchor });
  }, []);
  const isGroup = conversation.type === 'group';
  const convKey =
    isGroup && !conversation.generated
      ? conversation.group.identityValue
      : conversation.type === 'direct' && readonlyConversationKind(conversation) === 'official'
        ? conversation.otherUser.id
        : '';
  const showSenderNames = independent || conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;
  const groupMessages = useClientPreferences(() => preferenceValue('groupConsecutiveMessages'));
  const hidden = useMemo(
    () =>
      new Set([
        ...(hiddenIds ?? []),
        ...(preview ? [...loadHiddenMessageIds(conversation.id)].map(deletionIdentity) : []),
      ]),
    [hiddenIds, preview, conversation.id],
  );
  const visibleMessages = useMemo(
    () => (hidden.size ? messages.filter(({ id }) => !hidden.has(deletionIdentity(id))) : messages),
    [messages, hidden],
  );
  const positions = useMemo(() => {
    if (independent || !groupMessages) return undefined;
    const hiddenBetween = hiddenDeletionLookup(messages, hidden);
    return messageGroups(visibleMessages, {
      standalone: (message) => Boolean(deletedIds?.has(deletionIdentity(message.id))),
      breakBefore: (previous, current) =>
        Boolean(
          hiddenBetween(previous.msgSeq, current.msgSeq) || messageGapCount(previous, current),
        ),
    });
  }, [independent, groupMessages, hidden, deletedIds, messages, visibleMessages]);
  const galleryMessages = useMemo(
    () =>
      visibleMessages.map((message) => ({
        key: message.id,
        msgId: message.msgId || message.id,
        msgSeq: message.msgSeq,
        source: message.source,
        sourceFormat: message.sourceFormat,
        sendTime: (Date.parse(message.createdAt) || 0) / 1000,
        elements: message.qqElements ?? [],
      })),
    [visibleMessages],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const initialPositioned = useRef(false);
  const followBottom = useRef(true);
  const earlierPending = useRef(false);
  const anchor = useRef<ReturnType<typeof captureReadingAnchor> | null>(null);
  const replyScope = useRef(conversation.id);
  replyScope.current = conversation.id;

  async function jumpToReply(target: ReplyJumpTarget) {
    const scope = conversation.id;
    setReplyError('');
    const exact = target.msgId && visibleMessages.find((row) => row.id === target.msgId);
    const matchesById = target.msgId
      ? visibleMessages.filter((row) => row.msgId === target.msgId && !grayTipOf(row))
      : [];
    const match =
      exact ||
      (matchesById.length === 1 ? matchesById[0] : undefined) ||
      findReplySource(
        isGroup ? 'group' : 'c2c',
        {
          origMsgSeq: target.seq,
          origMsgIndex: target.index,
          origClientSeq: target.clientSeq,
          origSenderUin: target.senderUin,
          origMsgTime: target.sendTime,
        },
        visibleMessages
          .filter((row) => !grayTipOf(row))
          .map((row) => ({
            id: row.id,
            msgSeq: row.msgSeq ?? '',
            clientSeq: row.clientSeq,
            senderUid: row.senderUid,
            senderUin: row.sender?.identityValue ?? '',
            sendTime: row.sendTime ?? String(Date.parse(row.createdAt) / 1000),
            elements: row.qqElements ?? [],
          })),
      );
    if (match && 'id' in match && typeof match.id === 'string' && scrollRef.current) {
      followBottom.current = false;
      if (revealTimelineMessage(scrollRef.current, match.id, true)) return true;
    }
    try {
      if (await onLocateReply?.(target)) return true;
    } catch (error) {
      if (replyScope.current === scope)
        setReplyError(error instanceof Error ? error.message : '暂时无法定位引用消息。');
      return false;
    }
    if (replyScope.current === scope) setReplyError('当前记录里找不到这条引用消息。');
    return false;
  }

  const loadMore = useCallback(() => {
    if (!preview) {
      onLoadMore();
      return;
    }
    const element = scrollRef.current;
    if (!element || !initialPositioned.current || earlierPending.current || loadingMore || !hasMore)
      return;
    anchor.current = captureReadingAnchor(element, messages[0]?.id);
    earlierPending.current = true;
    onLoadMore();
  }, [preview, onLoadMore, loadingMore, hasMore, messages]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!preview || !element) return;
    if (loading) {
      initialPositioned.current = false;
      followBottom.current = true;
      anchor.current = null;
      earlierPending.current = false;
      return;
    }
    if (!initialPositioned.current && (messages.length || hasMore)) {
      element.scrollTop = element.scrollHeight;
      initialPositioned.current = true;
      followBottom.current = true;
    } else if (anchor.current && !loadingMore) {
      if (anchor.current.first !== messages[0]?.id) {
        const { id, top, height } = anchor.current;
        const row = id ? messageElement(element, id) : undefined;
        element.scrollTop +=
          row && top !== undefined
            ? row.getBoundingClientRect().top - top
            : element.scrollHeight - height;
      }
      anchor.current = null;
      earlierPending.current = false;
    }
  }, [preview, loading, loadingMore, messages, hasMore]);
  useEffect(() => {
    if (!preview || !historyRef.current) return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      if (element && followBottom.current && !anchor.current)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(historyRef.current);
    return () => observer.disconnect();
  }, [preview, loading, messages.length]);

  // 哨兵可见（距滚动容器底部 400px 内）即自动拉更新一页；失败/加载中时哨兵
  // 换成重试/加载态，观察器随之断开，避免空转重复请求。列表为空但 hasMore 时
  // 哨兵也保持挂载，让空窗（漫游未覆盖的旧端）能自动向后推进。
  const sentinelVisible = !loading && !loadingMore && !error && hasMore && !moreFailed;
  useEffect(() => {
    if (!sentinelVisible) return undefined;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelVisible, loadMore]);

  const content = (
    <ReplyJumpContext.Provider value={jumpToReply}>
      <div className={cn('weq-deleted', embedded && 'weq-private-preview-inline')}>
        <header className="weq-compose-head" data-window-drag-handle={!embedded || undefined}>
          {embedded ? (
            <button
              type="button"
              className="weq-compose-x"
              onClick={onClose}
              title={backLabel}
              aria-label={backLabel}
            >
              <ArrowLeft size={17} />
            </button>
          ) : null}
          <div className="weq-compose-titlewrap">
            <strong id="weq-gap-messages-title" className="weq-compose-title">
              {title ?? (preview ? '预览消息' : '缺失消息')}
            </strong>
            <span className="weq-compose-sub">{subtitle}</span>
          </div>
          {!embedded ? (
            <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
              <X size={17} />
            </button>
          ) : null}
        </header>
        {notice ? (
          <p role="status" style={{ color: 'var(--weq-fg-secondary)', padding: '0 16px' }}>
            {notice}
          </p>
        ) : null}
        {replyError ? (
          <p role="alert" className="weq-preview-message-note">
            {replyError}
          </p>
        ) : null}

        <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
          <ConvContext.Provider value={convKey}>
            <div
              ref={scrollRef}
              className={cn(
                'message-scroll',
                'weq-deleted-scroll',
                preview && 'weq-private-preview-scroll',
              )}
              onScroll={(event) => {
                if (!preview || loading) return;
                const element = event.currentTarget;
                followBottom.current =
                  element.scrollHeight - element.clientHeight - element.scrollTop < 40;
                if (anchor.current?.first === messages[0]?.id && anchor.current)
                  anchor.current = captureReadingAnchor(element, messages[0]?.id);
                if (element.scrollTop < 160 && !moreFailed) loadMore();
              }}
            >
              {loading ? (
                <div className={cn('weq-deleted-empty', 'weq-gap-loading')}>
                  <RefreshCw size={26} className="weq-gap-spin" />
                  <span>{preview ? '正在读取本地消息…' : '正在从 QQ 服务端拉取…'}</span>
                </div>
              ) : error ? (
                <div className="weq-deleted-empty">
                  <CloudOff size={26} />
                  <span>{error}</span>
                  {onRetry ? (
                    <button type="button" onClick={onRetry} className="weq-retry-button">
                      <RefreshCw size={14} aria-hidden />
                      重试
                    </button>
                  ) : null}
                </div>
              ) : visibleMessages.length === 0 && !hasMore ? (
                <div className="weq-deleted-empty">
                  <CloudOff size={26} />
                  <span className="weq-gap-empty-hint">
                    {preview ? '没有本地聊天记录' : '没有可拉取的消息'}
                  </span>
                </div>
              ) : (
                <div ref={historyRef}>
                  {preview ? (
                    <div className="weq-gap-footer weq-gap-history-top">
                      {loadingMore ? (
                        <span role="status">
                          <RefreshCw size={13} className="weq-gap-spin" />
                          正在加载更早的消息…
                        </span>
                      ) : moreFailed ? (
                        <button type="button" onClick={loadMore} className="weq-retry-button">
                          <RefreshCw size={14} aria-hidden />
                          加载失败，点击重试
                        </button>
                      ) : hasMore ? (
                        <div ref={sentinelRef}>向上滚动加载更早消息</div>
                      ) : (
                        <span>已到最早记录</span>
                      )}
                    </div>
                  ) : null}
                  {visibleMessages.map((message, index) => {
                    const sender = resolveMessageSender(message, conversation, user);
                    const groupPosition = positions?.[index];
                    const note = messageNotice?.(message);
                    return (
                      <div
                        key={message.id}
                        className="weq-preview-message-row"
                        style={{
                          paddingBlockEnd: messageTimelineSpacing(
                            groupPosition,
                            index === visibleMessages.length - 1,
                          ),
                        }}
                        tabIndex={0}
                        {...menu.rowProps(message)}
                      >
                        {!independent ? (
                          <MessageTimeDivider
                            value={message.createdAt}
                            visible={shouldShowMessageTime(
                              visibleMessages[index - 1]?.createdAt,
                              message.createdAt,
                            )}
                            precision={conversation.generated ? 'millisecond' : 'second'}
                          />
                        ) : null}
                        <MessageRow
                          message={message}
                          groupPosition={groupPosition}
                          conversation={conversation}
                          user={user}
                          sender={sender}
                          showSenderName={showSenderNames}
                          alwaysShowSenderName={independent}
                          alwaysShowTime={independent}
                          renderers={renderers}
                          deleted={deletedIds?.has(deletionIdentity(message.id))}
                          deletedKind={message.deletedKind}
                          recallRevokerName={message.recallRevokerName}
                          grayTipClassName="weq-preview-system-row"
                          onAvatarClick={preview && showSenderProfiles ? openMember : undefined}
                        />
                        {note ? <p className="weq-preview-message-note">{note}</p> : null}
                      </div>
                    );
                  })}
                  {!preview ? (
                    <div className="weq-gap-footer">
                      {loadingMore ? (
                        <span className="weq-gap-footer-spin">
                          <RefreshCw size={13} className="weq-gap-spin" />
                          {preview ? '正在加载更早的消息…' : '正在加载更新的消息…'}
                        </span>
                      ) : moreFailed ? (
                        <button
                          type="button"
                          className="weq-gap-footer-retry weq-retry-button"
                          onClick={loadMore}
                        >
                          <RefreshCw size={14} aria-hidden />
                          加载失败，点击重试
                        </button>
                      ) : hasMore ? (
                        <div ref={sentinelRef}>
                          {preview ? (
                            <NumericText>{`已加载 ${messages.length} 条 · 向下加载更早记录`}</NumericText>
                          ) : (
                            <NumericText>{`已加载 ${messages.length} / 共 ${totalCount} 条 · 向下滚动加载更多`}</NumericText>
                          )}
                        </div>
                      ) : (
                        <span>
                          已加载全部{' '}
                          <span className="weq-number weq-number-inherit">{messages.length}</span>{' '}
                          条
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            {menu.menu}
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </div>
      {memberCard ? (
        <MemberProfileCard
          member={memberCard.member}
          anchor={memberCard.anchor}
          groupCode={isGroup ? conversation.id : undefined}
          groupName={isGroup ? conversation.group.name : undefined}
          onClose={() => setMemberCard(null)}
          onOpenChat={
            openChat
              ? () => {
                  setMemberCard(null);
                  onClose();
                  openChat({ kind: 'direct', user: memberCard.member });
                }
              : undefined
          }
        />
      ) : null}
    </ReplyJumpContext.Provider>
  );
  return (
    <ChatMediaGallery
      scopeKey={conversation.id}
      conv={conversation.id}
      kind={isGroup ? 'group' : 'c2c'}
      messages={galleryMessages}
    >
      {embedded ? (
        content
      ) : (
        <Modal
          presentation="floating"
          onClose={onClose}
          width={GAP_MESSAGES_WIDTH}
          labelledBy="weq-gap-messages-title"
        >
          {content}
        </Modal>
      )}
    </ChatMediaGallery>
  );
}
