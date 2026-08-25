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
 *   - messages    拉取成功，逐条渲染。缺口超过 30 条时分页：首屏拿最新一段，
 *                 列表最新在最上；滚动到底（哨兵进入视口）触发 onLoadMore 拉
 *                 更旧的一段追加在末尾，直到 hasMore 为 false。
 *
 * 两个刻意限制：
 *   - 回复引用（reply）的点击跳转被禁用：缺失消息不在主时间线窗口里，跳转目标
 *     与滚动状态都对不上，这里用 noop 覆盖宿主注入的 jumpToSeq。
 *   - 群成员昵称 / 身份 / 等级 / 头衔由宿主按需解析后回填（同主消息窗口），
 *     本组件只负责渲染。
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { CloudOff, RefreshCw, X } from 'lucide-react';
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
  onLoadMore,
  onClose,
}: {
  conversation: Conversation;
  user: User;
  /** 已通过 messageToTemplate 构建好的模板消息（与主时间线同一管线）；最新在最上。 */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  /** 滚动到底后正在拉取更旧的一页。 */
  loadingMore: boolean;
  /** 拉取失败文案；非空且未在加载时整窗展示。 */
  error: string | null;
  /** 缺口还有更旧的一页可拉。 */
  hasMore: boolean;
  /** 拉取更多失败：哨兵停止自动触发，显示重试按钮。 */
  moreFailed: boolean;
  /** 缺口总条数（占位条估算），用于底部进度文案。 */
  totalCount: number;
  onLoadMore: () => void;
  onClose: () => void;
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 哨兵可见（距滚动容器底部 400px 内）即自动拉下一页；失败/加载中时哨兵换成
  // 重试/加载态，观察器随之断开，避免空转重复请求。
  const sentinelVisible = !loading && !error && messages.length > 0 && hasMore && !moreFailed;
  useEffect(() => {
    if (!sentinelVisible) return undefined;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelVisible, onLoadMore]);

  return (
    <Modal onClose={onClose} width={520} labelledBy="weq-gap-messages-title">
      {/* 缺失消息窗口不允许回复引用的点击跳转（状态太乱），用 noop 盖掉宿主的
          jumpToSeq，ReplyQuote 拿到后点了也不动。 */}
      <ReplyJumpContext.Provider value={noop}>
        <div className="weq-deleted">
          <header className="weq-compose-head">
            <div className="weq-compose-titlewrap">
              <strong id="weq-gap-messages-title" className="weq-compose-title">
                缺失消息
              </strong>
              <span className="weq-compose-sub">{subtitle}</span>
            </div>
            <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
              <X size={17} />
            </button>
          </header>

          <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
            <ConvContext.Provider value={convKey}>
              <div ref={scrollRef} className={cn('message-scroll', 'weq-deleted-scroll')}>
                {loading ? (
                  <div className={cn('weq-deleted-empty', 'weq-gap-loading')}>
                    <RefreshCw size={26} className="weq-gap-spin" />
                    <span>正在从 QQ 服务端拉取…</span>
                  </div>
                ) : error ? (
                  <div className="weq-deleted-empty">
                    <CloudOff size={26} />
                    <span>{error}</span>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="weq-deleted-empty">
                    <CloudOff size={26} />
                    <span>没有可拉取的消息</span>
                  </div>
                ) : (
                  <>
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
                    <div className="weq-gap-footer">
                      {loadingMore ? (
                        <span className="weq-gap-footer-spin">
                          <RefreshCw size={13} className="weq-gap-spin" />
                          正在加载更早的消息…
                        </span>
                      ) : moreFailed ? (
                        <button type="button" className="weq-gap-footer-retry" onClick={onLoadMore}>
                          加载失败，点击重试
                        </button>
                      ) : hasMore ? (
                        <div ref={sentinelRef}>
                          已加载 {messages.length} / 共 {totalCount} 条 · 滚动加载更多
                        </div>
                      ) : (
                        <span>已加载全部 {messages.length} 条</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </ConvContext.Provider>
          </ForwardKindContext.Provider>
        </div>
      </ReplyJumpContext.Provider>
    </Modal>
  );
}
