/**
 * GapMessagesModal — 「缺失消息」弹窗：聊天时间线里 QQ 从未同步到本机的消息。
 *
 * 占位条（MessageGapDivider）点击后由宿主通过
 * `account.fetchGapMessages` 按 seq 窗口从 QQ 服务端拉取，再像普通消息一样
 * 完整渲染（头像 / 昵称 / 装扮 / 消息体）。渲染管线与撤回列表一致：直接复用
 * 主时间线的 MessageBubble + renderers。
 *
 * 状态机：
 *   - loading     拉取中
 *   - error       拉取失败（漫游未开 / 消息过期 / 其它），整窗显示错误文案
 *   - messages    拉取成功，逐条渲染
 */

import type { ReactElement } from 'react';
import { CloudOff, RefreshCw, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext } from '../QqMessageContent';
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
  error,
  truncated,
  onClose,
}: {
  conversation: Conversation;
  user: User;
  /** 已通过 messageToTemplate 构建好的模板消息（与主时间线同一管线）。 */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  /** 拉取失败文案；非空且未在加载时整窗展示。 */
  error: string | null;
  /** 缺口超过拉取上限，只展示最新的一段。 */
  truncated?: boolean;
  onClose: () => void;
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group?.name : conversation.otherUser?.displayName;

  return (
    <Modal onClose={onClose} width={520} labelledBy="weq-gap-messages-title">
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
            <div className={cn('message-scroll', 'weq-deleted-scroll')}>
              {loading ? (
                <div className="weq-deleted-empty">
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
                  {truncated ? (
                    <div className="weq-deleted-empty">
                      <span>缺口过大，仅展示最新拉取到的 {messages.length} 条</span>
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
                </>
              )}
            </div>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </div>
    </Modal>
  );
}
