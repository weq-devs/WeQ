// @ts-nocheck
/**
 * 一条消息在**聊天时间线**里的完整渲染单元 —— 聊天区、转发窗口、合成转发预览
 * 三处共用同一份实现。
 *
 * 为什么要有这一层：主面板画一条消息其实是三层组装，而不是「一个消息体组件」——
 *
 *   chatPane        → 灰条分流（撤回 / 戳一戳 / 群提示 / 群通话结束 / QQ动态 / 窗口抖动）
 *   MessageBubble   → 气泡外壳（头像 / 昵称 / 徽章 / 贴表情 / 精华 / 撤回标签 / 删除面纱）
 *   qqMessageRenderer → QqMessageContent（消息体：文本 / 媒体 / 卡片 / 合并转发…）
 *
 * 合并转发窗口与合成转发编辑器此前只复用最里层那一层，于是凡是落在前两层里的元素
 * （灰条、动态卡、群通话结束…）在那边要么空白、要么退化成难看的普通气泡。把前两层
 * 抽到这里之后，三处的差异只剩「谁提供 sender / 谁处理右键菜单」这类宿主参数。
 *
 * 刻意不做的事：这里不查库、不发请求、不碰 proto。它只根据已经拿到的 `Message`
 * 决定「画成灰条还是画成气泡」。
 */

import type { ReactElement } from 'react';
import type { Conversation, Message, MessageAction, User } from './types';
import { MessageBubble } from './messageBubble';
import type { MessageRenderer } from './messageRenderers';
import { GrayTipPokeMessage } from '../../components/GrayTipPokeMessage';
import { GrayTipRevokeMessage } from '../../components/GrayTipRevokeMessage';
import { GrayTipGroupMessage } from '../../components/GrayTipGroupMessage';
import { GrayTipXmlMessage } from '../../components/GrayTipXmlMessage';
import { GrayTipFileRecvMessage } from '../../components/GrayTipFileRecvMessage';
import { GrayTipTempSessionMessage } from '../../components/GrayTipTempSessionMessage';
import {
  GroupCallEndedMessage,
  GROUP_CALL_ENDED_SUBTYPES,
} from '../../components/GroupCallEndedMessage';
import { QqDynamic } from '../../components/QqDynamic';

/**
 * 画成**居中灰条**（不套气泡、不显示头像昵称）的元素 kind。
 *
 * 群通话 / 群课堂的「已结束」（CALL 元素，subType 16/25/29）也算：那条消息的发送者
 * 是空的，套气泡会凭空多出一个发送者，所以走灰条；发起那条有正常发送人，仍走气泡。
 *
 * 不在内：乐观渲染的窗口抖动（windowShake）不是灰条 —— 它是自己发出的一条消息，
 * 由 `QqMessageContent` 在 `sticker-only` 容器里画成那枚「戳一戳」超级表情，落在
 * 自己那一侧（见 `WindowShakeMessage`）。在这里拦下来会让那条分支永远走不到。
 */
export const GRAY_TIP_KINDS: string[] = [
  'grayTipPoke',
  'grayTipRevoke',
  'grayTipGroup',
  'grayTipXml',
  'grayTipFileRecv',
  'grayTipTempSession',
  'qqDynamic',
];

/** 一条消息携带的元素（模板层叫 qqElements，转发窗口用 elements）。 */
export function messageElements(
  message: unknown,
): { type?: string; data?: Record<string, unknown> }[] {
  const raw =
    (message as { qqElements?: unknown[] })?.qqElements ??
    (message as { elements?: unknown[] })?.elements ??
    [];
  return Array.isArray(raw) ? (raw as { type?: string; data?: Record<string, unknown> }[]) : [];
}

export interface GrayTipMatch {
  kind: string;
  el: { type?: string; data?: Record<string, unknown> };
}

/**
 * 这条消息该不该画成灰条、画成哪一种。
 *
 * 返回 null = 普通消息，走气泡。判断顺序与旧的 chatPane 内联实现完全一致（按
 * {@link GRAY_TIP_KINDS} 的顺序取第一个命中的元素），所以聊天区行为不变。
 */
export function grayTipOf(message: unknown): GrayTipMatch | null {
  const els = messageElements(message);
  for (const kind of GRAY_TIP_KINDS) {
    const el = els.find((e) => e?.type === kind);
    if (el) return { kind, el };
  }
  const callEnded = els.find(
    (e) => e?.type === 'call' && GROUP_CALL_ENDED_SUBTYPES.has(Number(e?.data?.subType)),
  );
  if (callEnded) return { kind: 'groupCallEnded', el: callEnded };
  return null;
}

/**
 * 一条灰条的**内容**（不含外层容器）。宿主自己决定外面包什么 —— 聊天区包一层带
 * `data-message-id` 的 div（为了右键菜单定位），转发窗口直接放进行里。
 */
export function GrayTipLine({
  gt,
  conversation,
  message,
  user,
}: {
  gt: GrayTipMatch;
  conversation?: Conversation;
  message?: Message;
  user?: User;
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
        />
      );
    case 'grayTipGroup':
      return (
        <GrayTipGroupMessage
          element={gt.el as never}
          conversation={conversation as never}
          message={message as never}
        />
      );
    case 'grayTipXml':
      return <GrayTipXmlMessage element={gt.el as never} conversation={conversation as never} />;
    case 'grayTipFileRecv':
      return <GrayTipFileRecvMessage element={gt.el as never} />;
    case 'grayTipTempSession':
      return <GrayTipTempSessionMessage element={gt.el as never} />;
    case 'groupCallEnded':
      return <GroupCallEndedMessage element={gt.el as never} />;
    case 'qqDynamic': {
      const d = (gt.el.data ?? {}) as Record<string, unknown>;
      return (
        <div className="flex justify-center py-1">
          <QqDynamic
            desc={d.dynamicDesc as { mainDesc?: string; subDesc?: string } | undefined}
            desc2={d.dynamicDesc2 as { mainDesc?: string; subDesc?: string } | undefined}
            coverUrl={d.dynamicCoverUrl as string | undefined}
            zoneLogoUrl={d.dynamicZoneLogoUrl as string | undefined}
          />
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
 * 宿主差异全部走 props（右键菜单 / 多选 / 删除恢复 / 头像点击），所以聊天区传全套，
 * 转发窗口只传消息本身也能得到和主面板一致的画法。
 */
export function MessageRow({
  message,
  conversation,
  user,
  sender,
  renderers,
  showSenderName = true,
  active = false,
  deleted = false,
  deletedKind,
  recallRevokerName,
  onRestore,
  onContextMenu,
  onLongPress,
  onAction,
  onAvatarClick,
  onAvatarContextMenu,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  /** 灰条外层的 class（聊天区靠它对齐，转发窗口用窄一点的边距）。 */
  grayTipClassName,
}: {
  message: Message;
  conversation: Conversation;
  user: User;
  /** 已解析的发送者；不传则本组件自己解析（转发窗口没有 memberMap 时可省）。 */
  sender?: User;
  /** 消息体渲染器注册表（聊天区传 qqMessageRenderer 那份）。 */
  renderers?: MessageRenderer[];
  showSenderName?: boolean;
  active?: boolean;
  deleted?: boolean;
  deletedKind?: 'weq' | 'qq';
  recallRevokerName?: string;
  onRestore?: (msgId: string) => Promise<void>;
  onContextMenu?: (event: unknown, message: Message) => void;
  onLongPress?: (point: { x: number; y: number }, message: Message) => void;
  onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
  onAvatarClick?: (sender: User, anchor: { x: number; y: number }) => void;
  onAvatarContextMenu?: (event: unknown, sender: User) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (message: Message) => void;
  grayTipClassName?: string;
}): ReactElement {
  const gt = grayTipOf(message);
  if (gt) {
    return (
      // 右鍵菜单与普通消息同一入口（聊天区靠它弹「复制 / 删除 / 多选」），
      // 所以这一层必须保留 data-message-id 与 onContextMenu。
      <div
        className={grayTipClassName}
        data-message-id={message.id}
        onContextMenu={onContextMenu ? (event) => onContextMenu(event, message) : undefined}
      >
        <GrayTipLine gt={gt} conversation={conversation} message={message} user={user} />
      </div>
    );
  }
  // MessageBubble 的长按 / 右键处理器是必填的（会直接调用），宿主没给时补空实现 ——
  // 转发窗口这类「只读视图」不接菜单，但也不能因为手指长按就崩。
  const noopContextMenu = onContextMenu ?? (() => {});
  const noopLongPress = onLongPress ?? (() => {});
  return (
    <MessageBubble
      message={message}
      conversation={conversation}
      sender={sender ?? user}
      mine={message.senderId === user.id}
      senderName={sender ? displayNameOf(sender) : displayNameOf(user)}
      senderAvatarUrl={(sender ?? user).avatarUrl}
      senderSeed={(sender ?? user).identityValue}
      senderKind={(sender ?? user).kind}
      showSenderName={showSenderName}
      active={active}
      renderers={renderers}
      deleted={deleted}
      deletedKind={deletedKind}
      recallRevokerName={recallRevokerName}
      onRestore={onRestore}
      onContextMenu={noopContextMenu}
      onLongPress={noopLongPress}
      onAction={onAction}
      onAvatarClick={onAvatarClick}
      onAvatarContextMenu={onAvatarContextMenu}
      selectionMode={selectionMode}
      selected={selected}
      onToggleSelect={onToggleSelect}
    />
  );
}

function displayNameOf(user: User): string {
  return user.displayName || user.username || '';
}
