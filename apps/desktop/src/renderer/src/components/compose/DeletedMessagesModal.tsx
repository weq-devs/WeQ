/**
 * DeletedMessagesModal — browse a conversation's soft-deleted (hidden but
 * restorable) messages and bring any of them back.
 *
 * To stay visually identical to the live chat, it renders each deleted message
 * with the SAME `MessageBubble` + renderers the chat pane uses, inside a
 * `message-scroll` container. The only extra affordance is a per-message
 * “恢复” button. Message objects are built by the caller (MainView) through the
 * exact `messageToTemplate` pipeline, so senders/avatars/replies match the chat.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { ConvContext, ForwardKindContext } from '../QqMessageContent';
import { cn } from '../../im-template/template/classNames';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { resolveMessageSender } from '../../im-template/template/conversationDisplay';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';

const noop = (): void => {};

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
  const subtitle = isGroup ? conversation.group.name : conversation.otherUser.displayName;

  // Optimistically drop a row the instant its restore resolves, so the panel
  // feels live even before the parent refetches.
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const visible = useMemo(
    () => messages.filter((m) => !restoredIds.has(m.id)),
    [messages, restoredIds],
  );

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
    <Modal onClose={onClose} width={520} labelledBy="weq-deleted-title">
      <div className="weq-deleted">
        <header className="weq-compose-head">
          <div className="weq-compose-titlewrap">
            <strong id="weq-deleted-title" className="weq-compose-title">查看删除消息</strong>
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
              ) : visible.length === 0 ? (
                <div className="weq-deleted-empty">
                  <Trash2 size={26} />
                  <span>没有已删除的消息</span>
                  <small>在聊天里右键消息「删除」后，会出现在这里，可随时恢复。</small>
                </div>
              ) : (
                visible.map((message) => {
                  const mine = message.senderId === user.id;
                  const sender = resolveMessageSender(message, conversation, user);
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
                          onContextMenu={noop}
                          onLongPress={noop}
                        />
                      </div>
                      <button
                        type="button"
                        className="weq-deleted-restore"
                        title="恢复这条消息"
                        disabled={restoringId === message.id}
                        onClick={() => void restore(message)}
                      >
                        <RotateCcw size={14} />
                        <span>{restoringId === message.id ? '恢复中…' : '恢复'}</span>
                      </button>
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
