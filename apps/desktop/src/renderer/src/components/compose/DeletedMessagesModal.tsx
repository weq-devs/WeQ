/**
 * DeletedMessagesModal — the "删除列表": browse the messages WeQ deleted in one
 * conversation and bring any of them back.
 *
 * WeQ's delete mirrors QQ's own recall (40011/40012 → (1,1) in place), so the
 * deleted messages ALSO stay visible in the chat under a translucent overlay —
 * this panel is the centralized management view of the same set.
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
            <strong id="weq-deleted-title" className="weq-compose-title">删除列表</strong>
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
                  <small>在聊天里右键消息「删除」后，消息会以半透明样式留在原位，也会出现在这里，可随时恢复。对方撤回 / 在其他设备删除的消息也会出现在这里（标记为「QQ删除」，无法恢复）。</small>
                </div>
              ) : (
                visible.map((message) => {
                  const mine = message.senderId === user.id;
                  const sender = resolveMessageSender(message, conversation, user);
                  const kind = (message as { deletedKind?: 'weq' | 'qq' }).deletedKind ?? 'weq';
                  const restorable = kind !== 'qq';
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
                          deletedKind={kind}
                          onContextMenu={noop}
                          onLongPress={noop}
                        />
                      </div>
                      {restorable ? (
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
                      ) : (
                        <span className="weq-deleted-tag" title="QQ 本体删除/撤回，无法恢复">
                          QQ删除
                        </span>
                      )}
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
