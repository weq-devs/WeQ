/**
 * GapMessagesModal — 「缺失消息」弹窗：聊天时间线里 QQ 从未同步到本机的消息。
 *
 * 占位条（MessageGapDivider）点击后由宿主通过
 * `account.fetchGapMessages` 按 seq 窗口从 QQ 服务端拉取，再像普通消息一样
 * 完整渲染（头像 / 昵称 / 装扮 / 消息体）。渲染管线与撤回列表一致：直接复用
 * 主时间线的 MessageBubble + renderers。
 *
 * 状态机：
 *   - loading     拉取中（首屏）
 *   - error       拉取失败（漫游未开 / 消息过期 / 其它），整窗显示错误文案
 *   - messages    拉取成功，逐条渲染。缺口超过 30 条时分页：首屏拿最旧一段
 *                 垫底，列表按 seq 升序（旧在上、新在下）；滚动到底（底部哨
 *                 兵进入视口）触发 onLoadMore 拉更新的一段 append 到尾部，
 *                 直到 hasMore 为 false。
 *
 * 两个刻意限制：
 *   - 回复引用（reply）的点击跳转被禁用：缺失消息不在主时间线窗口里，跳转目标
 *     与滚动状态都对不上，这里用 noop 覆盖宿主注入的 jumpToSeq。
 *   - 群成员昵称 / 身份 / 等级 / 头衔由宿主按需解析后回填（同主消息窗口），
 *     本组件只负责渲染。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactElement } from 'react';
import '../../styles/private-preview.css';
import { ArrowLeft, CloudOff, RefreshCw, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext, ReplyJumpContext } from '../QqMessageContent';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';

const noop = (): void => {};

export function GapMessagesModal({
  conversation,
  user,
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
}: {
  conversation: Conversation;
  user: User;
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
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const initialPositioned = useRef(false);
  const followBottom = useRef(true);
  const earlierPending = useRef(false);
  const anchor = useRef<{ height: number; top: number; first?: string } | null>(null);
  const loadMore = useCallback(() => {
    if (!preview) {
      onLoadMore();
      return;
    }
    const element = scrollRef.current;
    if (!element || !initialPositioned.current || earlierPending.current || loadingMore || !hasMore)
      return;
    anchor.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      first: messages[0]?.id,
    };
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
    if (!initialPositioned.current && messages.length) {
      element.scrollTop = element.scrollHeight;
      initialPositioned.current = true;
      followBottom.current = true;
    } else if (anchor.current && !loadingMore) {
      if (anchor.current.first !== messages[0]?.id)
        element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
      earlierPending.current = false;
    }
  }, [preview, loading, loadingMore, messages]);
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
    <ReplyJumpContext.Provider value={noop}>
      {/* 缺失消息窗口和只读预览不跳转主时间线的引用消息。 */}
      <div className={cn('weq-deleted', embedded && 'weq-private-preview-inline')}>
        <header className="weq-compose-head" data-window-drag-handle={!embedded || undefined}>
          {embedded ? (
            <button
              type="button"
              className="weq-compose-x"
              onClick={onClose}
              title="返回资料"
              aria-label="返回资料"
            >
              <ArrowLeft size={17} />
            </button>
          ) : null}
          <div className="weq-compose-titlewrap">
            <strong id="weq-gap-messages-title" className="weq-compose-title">
              {preview ? '预览私聊' : '缺失消息'}
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
                    <button type="button" onClick={onRetry}>
                      重试
                    </button>
                  ) : null}
                </div>
              ) : messages.length === 0 && !hasMore ? (
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
                        <button type="button" onClick={loadMore}>
                          加载失败，点击重试
                        </button>
                      ) : hasMore ? (
                        <div ref={sentinelRef}>向上滚动加载更早消息</div>
                      ) : (
                        <span>已到最早记录</span>
                      )}
                    </div>
                  ) : null}
                  {messages.map((message) => {
                    const mine = message.senderId === user.id;
                    const sender = resolveMessageSender(message, conversation, user);
                    return (
                      <div key={message.id} className={cn('weq-deleted-row', mine && 'is-mine')}>
                        <div className="weq-deleted-bubble">
                          <MessageBubble
                            message={message}
                            conversation={conversation}
                            sender={sender}
                            mine={mine}
                            senderName={displayUserName(sender)}
                            senderAvatarUrl={sender.avatarUrl}
                            senderSeed={sender.identityValue}
                            senderKind={sender.kind}
                            showSenderName={showSenderNames}
                            active={false}
                            renderers={renderers}
                            onContextMenu={noop}
                            onLongPress={noop}
                          />
                        </div>
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
                        <button type="button" className="weq-gap-footer-retry" onClick={loadMore}>
                          加载失败，点击重试
                        </button>
                      ) : hasMore ? (
                        <div ref={sentinelRef}>
                          {preview
                            ? `已加载 ${messages.length} 条 · 向下加载更早记录`
                            : `已加载 ${messages.length} / 共 ${totalCount} 条 · 向下滚动加载更多`}
                        </div>
                      ) : (
                        <span>已加载全部 {messages.length} 条</span>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </div>
    </ReplyJumpContext.Provider>
  );
  return embedded ? (
    content
  ) : (
    <Modal
      presentation="floating"
      onClose={onClose}
      width={520}
      labelledBy="weq-gap-messages-title"
    >
      {content}
    </Modal>
  );
}
