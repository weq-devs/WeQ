/**
 * 主聊天、会话预览和聊天记录结果共用的单条消息渲染。
 * 宿主提供会话和操作，消息行分流灰条和普通气泡。
 */

import type { ReactElement, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { memo, useMemo } from 'react';
import { recordMessageCounter } from '../../lib/messagePerformance';
import type { ProfileShortcut } from '../../lib/profileClick';
import { MessageSelectionMark } from '../../components/MessageSelectionMark';
import type { Conversation, Message, MessageAction, User } from './types';
import { MessageBubble } from './messageBubble';
import { resolveMessageSender } from './conversationDisplay';
import type { MessageRenderer } from './messageRenderers';
import { GrayTipPokeMessage } from '../../components/GrayTipPokeMessage';
import { GrayTipRevokeMessage } from '../../components/GrayTipRevokeMessage';
import { GrayTipGroupMessage } from '../../components/GrayTipGroupMessage';
import { GrayTipXmlMessage } from '../../components/GrayTipXmlMessage';
import { GrayTipFileRecvMessage } from '../../components/GrayTipFileRecvMessage';
import { GrayTipTempSessionMessage } from '../../components/GrayTipTempSessionMessage';
import { GroupCallEndedMessage } from '../../components/GroupCallEndedMessage';
import { QqDynamic } from '../../components/QqDynamic';
import { qqDynamicElementProps } from '../../components/QqDynamic.shared';
import { SystemMessageContent } from '../../components/MessageProvenance';
import type { ReactionInteraction } from '../../components/SetEmojiReactions';
import { isSelfIdentity, selfIdentityValues } from '../../lib/selfIdentity';
import { VirtualConversationBadge } from '../../components/VirtualConversationAvatar';
import { type GrayTipMatch, grayTipOf } from './messageRow.shared';
import type { MessageGroupPosition } from './chatTimelineModel';

/**
 * 一条灰条的**内容**（不含外层容器）。宿主自己决定外面包什么 —— 聊天区包一层带
 * `data-message-id` 的 div（为了右键菜单定位），转发窗口直接放进行里。
 */
export function GrayTipLine({
  gt,
  conversation,
  message,
  user,
  onReedit,
}: {
  gt: GrayTipMatch;
  conversation?: Conversation;
  message?: Message;
  user?: User;
  onReedit?: (message: Message) => Promise<boolean>;
}): ReactElement | null {
  switch (gt.kind) {
    case 'grayTipPoke':
      return (
        <GrayTipPokeMessage
          element={gt.el as never}
          conversation={conversation as never}
          message={message as never}
          user={user}
        />
      );
    case 'grayTipRevoke':
      return (
        <GrayTipRevokeMessage
          element={gt.el as never}
          conversation={conversation as never}
          message={message as never}
          user={user}
          onReedit={onReedit}
        />
      );
    case 'grayTipGroup':
      return (
        <GrayTipGroupMessage
          element={gt.el as never}
          conversation={conversation as never}
          message={message as never}
          user={user}
        />
      );
    case 'grayTipXml':
      return (
        <GrayTipXmlMessage
          element={gt.el as never}
          conversation={conversation}
          message={message}
          user={user}
        />
      );
    case 'grayTipFileRecv':
      return (
        <GrayTipFileRecvMessage
          element={gt.el as never}
          conversation={conversation}
          message={message}
        />
      );
    case 'grayTipTempSession':
      return <GrayTipTempSessionMessage element={gt.el as never} />;
    case 'groupCallEnded':
      return <GroupCallEndedMessage element={gt.el as never} />;
    case 'qqDynamic': {
      const d = (gt.el.data ?? {}) as Record<string, unknown>;
      return (
        <div className="flex justify-center py-1">
          <QqDynamic {...qqDynamicElementProps(d)} />
        </div>
      );
    }
    default:
      return null;
  }
}

/**
 * 一条消息的完整渲染单元：命中灰条 → {@link GrayTipLine}；否则 → `MessageBubble`。
 *
 * 右键菜单、多选、删除恢复和头像操作由宿主按消息来源提供。
 */
export const MessageRow = memo(function MessageRow({
  message,
  groupPosition,
  conversation,
  user,
  sender,
  renderers,
  showSenderName = true,
  alwaysShowSenderName,
  alwaysShowTime,
  alwaysShowDate,
  active = false,
  deleted = false,
  deletedKind,
  recallRevokerName,
  hideRecallTag,
  onRestore,
  onContextMenu,
  onLongPress,
  onSwipeReply,
  onAction,
  onReedit,
  onDismissUnsent,
  onStartOutgoing,
  onAvatarClick,
  getAvatarChatShortcut,
  onAvatarContextMenu,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  reactionInteraction,
  onReactionChange,
  reactionBlockedReason,
  reactionBusy,
  reactionPending,
  repeatAction,
  pendingAction,
  textResult,
  textResultRevision,
  /** 灰条外层的 class（聊天区靠它对齐，转发窗口用窄一点的边距）。 */
  grayTipClassName,
}: {
  message: Message;
  groupPosition?: MessageGroupPosition;
  conversation: Conversation;
  user: User;
  /** 已解析的发送者；缺省时从消息与会话资料解析。 */
  sender?: User;
  /** 消息体渲染器注册表（聊天区传 qqMessageRenderer 那份）。 */
  renderers?: MessageRenderer[];
  showSenderName?: boolean;
  alwaysShowSenderName?: boolean;
  alwaysShowTime?: boolean;
  alwaysShowDate?: boolean;
  active?: boolean;
  deleted?: boolean;
  deletedKind?: 'weq' | 'qq';
  recallRevokerName?: string;
  hideRecallTag?: boolean;
  onRestore?: (msgId: string) => Promise<void>;
  onContextMenu?: (event: ReactMouseEvent, message: Message) => void;
  onLongPress?: (
    point: { x: number; y: number },
    message: Message,
    target?: EventTarget | null,
  ) => void;
  onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
  onSwipeReply?: (message: Message) => void;
  onReedit?: (message: Message) => Promise<boolean>;
  /** 「可能未送达」占位的移除（见 MessageBubble 的同名 prop）。 */
  onDismissUnsent?: (message: Message) => void;
  onStartOutgoing?: (message: Message) => void;
  onAvatarClick?: (sender: User, anchor: { x: number; y: number }) => void;
  getAvatarChatShortcut?: (sender: User) => ProfileShortcut | undefined;
  onAvatarContextMenu?: (event: ReactMouseEvent, sender: User) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (message: Message, event?: ReactMouseEvent) => void;
  reactionInteraction?: ReactionInteraction;
  onReactionChange?: (message: Message, code: string, isSet: boolean) => void;
  reactionBlockedReason?: string | null;
  reactionBusy?: boolean;
  reactionPending?: ReactionInteraction['pending'];
  repeatAction?: ReactNode;
  pendingAction?: ReactNode;
  textResult?: ReactNode;
  textResultRevision?: unknown;
  grayTipClassName?: string;
}): ReactElement {
  recordMessageCounter('rowRenders');
  const reactions = useMemo(
    () =>
      onReactionChange
        ? {
            onChange: (code: string, isSet: boolean) => onReactionChange(message, code, isSet),
            blockedReason: reactionBlockedReason,
            busy: reactionBusy,
            pending: reactionPending,
          }
        : reactionInteraction,
    [
      onReactionChange,
      message,
      reactionBlockedReason,
      reactionBusy,
      reactionPending,
      reactionInteraction,
    ],
  );
  const gt = grayTipOf(message);
  if (gt) {
    return (
      // 右鍵菜单与普通消息同一入口（聊天区靠它弹「复制 / 删除 / 多选」），
      // 所以这一层必须保留 data-message-id 与 onContextMenu。
      <div
        className={[
          grayTipClassName,
          'weq-system-message-row',
          'weq-message-selectable',
          selectionMode ? 'selection-mode' : '',
          selected ? 'is-selected' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-message-id={message.id}
        data-weq-select-id={selectionMode ? message.id : undefined}
        data-weq-selection-id={selectionMode ? message.id : undefined}
        tabIndex={selectionMode ? 0 : -1}
        onContextMenu={onContextMenu ? (event) => onContextMenu(event, message) : undefined}
        onClickCapture={
          selectionMode && onToggleSelect
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleSelect(message, event);
              }
            : undefined
        }
      >
        {selectionMode ? <MessageSelectionMark selected={selected} /> : null}
        <SystemMessageContent
          message={message}
          alwaysShowTime={alwaysShowTime}
          alwaysShowDate={alwaysShowDate}
        >
          <GrayTipLine
            gt={gt}
            conversation={conversation}
            message={message}
            user={user}
            onReedit={selectionMode ? undefined : onReedit}
          />
        </SystemMessageContent>
      </div>
    );
  }
  // 只读列表可在外层接管长按和右键。
  const noopContextMenu = onContextMenu ?? (() => {});
  const noopLongPress = onLongPress ?? (() => {});
  const author = sender ?? resolveMessageSender(message, conversation, user);
  return (
    <MessageBubble
      message={message}
      groupPosition={groupPosition}
      conversation={conversation}
      sender={author}
      mine={isSelfIdentity(new Set(selfIdentityValues(user)), message.senderId)}
      senderName={message.historicalSenderName || displayNameOf(author)}
      senderAvatarUrl={author.avatarUrl}
      senderSeed={author.identityValue}
      senderKind={author.kind}
      avatarBadge={author.clone ? <VirtualConversationBadge /> : undefined}
      showSenderName={showSenderName || Boolean(message.historicalSenderName)}
      alwaysShowSenderName={alwaysShowSenderName}
      alwaysShowTime={alwaysShowTime}
      alwaysShowDate={alwaysShowDate}
      active={active}
      renderers={renderers}
      deleted={deleted}
      deletedKind={deletedKind ?? message.deletedKind}
      recallRevokerName={recallRevokerName ?? message.recallRevokerName}
      hideRecallTag={hideRecallTag}
      onRestore={onRestore}
      onContextMenu={noopContextMenu}
      onLongPress={noopLongPress}
      onSwipeReply={onSwipeReply}
      onAction={onAction}
      onReedit={onReedit}
      onDismissUnsent={onDismissUnsent}
      onStartOutgoing={onStartOutgoing}
      onAvatarClick={onAvatarClick}
      getAvatarChatShortcut={getAvatarChatShortcut}
      onAvatarContextMenu={onAvatarContextMenu}
      selectionMode={selectionMode}
      selected={selected}
      onToggleSelect={onToggleSelect}
      reactionInteraction={reactions}
      repeatAction={repeatAction}
      pendingAction={pendingAction}
      textResult={textResult}
      textResultRevision={textResultRevision}
    />
  );
});

function displayNameOf(user: User): string {
  return user.displayName || user.username || '';
}
export type { GrayTipMatch } from './messageRow.shared';
