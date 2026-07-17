/**
 * RecalledMessagesModal — the "撤回列表": browse the messages that were recalled
 * in one conversation while anti-recall was protecting it.
 *
 * Unlike deletes, a recalled message's original content is NOT hidden: the
 * anti-recall SQL trigger cancels QQ's recall in place, so the real row survives
 * and renders normally. This panel is the centralized view of everything the
 * trigger caught — each row shows the original message (via the SAME
 * `MessageBubble` + renderers the chat uses) plus who recalled it and when.
 *
 * There is deliberately NO restore button (the message was never removed). Rows
 * are built by the caller (MainView) through the exact `messageToTemplate`
 * pipeline, so senders/avatars/replies match the live chat.
 */

import { type ReactElement } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext } from '../QqMessageContent';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';

const noop = (): void => {};

/** Format a unix-second recall timestamp as a short local date-time. */
function formatRecallTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RecalledMessagesModal({
  conversation,
  user,
  messages,
  renderers,
  loading,
  onClose,
}: {
  conversation: Conversation;
  user: User;
  /** Recalled messages, newest-recall-first, already built via messageToTemplate. */
  messages: Message[];
  renderers?: MessageRenderer[];
  loading: boolean;
  onClose: () => void;
}): ReactElement {
  const isGroup = conversation.type === 'group';
  const convKey = isGroup ? conversation.group.identityValue : '';
  const showSenderNames = conversation.type !== 'direct';
  const subtitle = isGroup ? conversation.group.name : conversation.otherUser.displayName;

  return (
    <Modal onClose={onClose} width={520} labelledBy="weq-recalled-title">
      <div className="weq-deleted">
        <header className="weq-compose-head">
          <div className="weq-compose-titlewrap">
            <strong id="weq-recalled-title" className="weq-compose-title">撤回列表</strong>
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
                <div className="weq-deleted-empty">加载中…</div>
              ) : messages.length === 0 ? (
                <div className="weq-deleted-empty">
                  <RotateCcw size={26} />
                  <span>没有被撤回的消息</span>
                  <small>开启防撤回后，对方撤回的消息会被拦截并保留在原位，也会出现在这里，标注撤回者与时间。</small>
                </div>
              ) : (
                messages.map((message) => {
                  const mine = message.senderId === user.id;
                  const sender = resolveMessageSender(message, conversation, user);
                  const recall = (message as { recall?: { revokeUid: string; sameSender: boolean; recallTs: number } }).recall;
                  const revokerName = (message as { recallRevokerName?: string }).recallRevokerName;
                  const who = !recall
                    ? ''
                    : recall.sameSender
                      ? (mine ? '你撤回' : '本人撤回')
                      : `${revokerName?.trim() || '管理员'} 撤回`;
                  const when = recall ? formatRecallTime(recall.recallTs) : '';
                  return (
                    <div key={message.id} className="weq-deleted-row">
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
                          recallRevokerName={revokerName}
                          onContextMenu={noop}
                          onLongPress={noop}
                        />
                      </div>
                      <span className="weq-deleted-tag" title="撤回者与撤回时间">
                        {who}{when ? ` · ${when}` : ''}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </ConvContext.Provider>
        </ForwardKindContext.Provider>
      </div>
    </Modal>
  );
}
