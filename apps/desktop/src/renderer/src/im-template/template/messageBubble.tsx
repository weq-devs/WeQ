// @ts-nocheck
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Check, Clock, RotateCcw, Sparkle, X } from 'lucide-react';
import { renderMessageWithRegistry, type MessageRenderer } from './messageRenderers';
import { Avatar } from './primitives';
import type { Conversation, Message, MessageAction, User } from './types';
import { cn } from './classNames';
import { SetEmojiReactions } from '../../components/SetEmojiReactions';
import { useSelfPendant } from '../../hooks/useSelfPendant';
import { useActiveFontFx, useActiveWidget } from '../../hooks/useActiveWidget';
import { useBubbleFontFx } from '../../hooks/useBubbleFontFx';
import { useMsgDecoration } from '../../hooks/useMsgDecoration';

// 猜测式回退（newPreview 拼接，见 msg_decoration.ts）常年会有下架/过期 404。加载失败
// 就把 <img> 本身藏起来，别让浏览器画那个裂图占位——头像本体照常显示，只是没有这个
// 装饰角标。真动画帧（CSS 背景图 keyframes）走本地 protocol 文件，不会 404，不需要这层。
function hideBrokenImg(event: { currentTarget: HTMLImageElement }) {
  event.currentTarget.style.display = 'none';
}

/**
 * 头像挂件叠加层。`widget.animated` 时渲染一个空 `<span>`，真正的画面由
 * `data-widget` 属性选中后注入的 CSS `@keyframes`（见 msgDecorationStyle.ts 的
 * injectWidgetCss）逐帧切 `background-image`；否则退回普通 `<img src>`（猜测的
 * newPreview URL，或 mine 消息在没有 per-message widget 时用的自己头像挂件）。
 */
function PendantOverlay({
  name,
  avatarUrl,
  seed,
  widget,
  fallbackUrl,
}: {
  name: string;
  avatarUrl?: string;
  seed?: string;
  widget: { animated: boolean; url?: string } | null;
  fallbackUrl?: string | null;
}) {
  const staticUrl = widget ? (widget.animated ? undefined : widget.url) : fallbackUrl;
  if (!widget?.animated && !staticUrl) {
    return <Avatar name={name} avatarUrl={avatarUrl} seed={seed} />;
  }
  return (
    <span className={cn('weq-avatar-pendant')}>
      <Avatar name={name} avatarUrl={avatarUrl} seed={seed} />
      {widget?.animated ? (
        <span className={cn('weq-avatar-pendant-img')} aria-hidden />
      ) : (
        <img
          className={cn('weq-avatar-pendant-img')}
          src={staticUrl}
          alt=""
          aria-hidden
          draggable={false}
          onError={hideBrokenImg}
        />
      )}
    </span>
  );
}

export function MessageBubble({
  message,
  conversation,
  sender,
  mine,
  senderName,
  senderAvatarUrl,
  senderSeed,
  senderKind,
  showSenderName,
  active,
  renderers,
  deleted,
  deletedKind,
  recallRevokerName,
  onRestore,
  onContextMenu,
  onLongPress,
  onAction,
  onAvatarClick,
  selected,
  selectionMode,
  onToggleSelect,
}: {
  message: Message;
  conversation: Conversation;
  sender: User;
  mine: boolean;
  senderName: string;
  senderAvatarUrl: string | null;
  senderSeed: string;
  senderKind?: 'human' | 'bot';
  showSenderName: boolean;
  active: boolean;
  renderers?: MessageRenderer[];
  /** WeQ-deleted: rendered in place under a translucent overlay + restore-on-hover. */
  deleted?: boolean;
  /**
   * Deleted origin: `'weq'` (WeQ deleted, restorable) or `'qq'` (QQ-native
   * recall / delete elsewhere, NOT restorable → "QQ删除" veil, no restore
   * button). Preferred over the legacy boolean `deleted`.
   */
  deletedKind?: 'weq' | 'qq';
  /**
   * Recall reviser's display name — shown in the 撤回 tag when an admin recalled
   * someone else's message (`recall.sameSender === false`). Resolved by the
   * parent from `message.recall.revokeUid`.
   */
  recallRevokerName?: string;
  /** Restore a WeQ-deleted message (only used when `deleted`). */
  onRestore?: (msgId: string) => Promise<void>;
  onContextMenu: (event: ReactMouseEvent, message: Message) => void;
  onLongPress: (point: { x: number; y: number }, message: Message) => void;
  onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
  onAvatarClick?: (sender: User, anchor: { x: number; y: number }) => void;
  /** 多选：这一行被选中（整行高亮 + 勾选标）。 */
  selected?: boolean;
  /** 多选模式：点击整行切换选中（而不是触发右键菜单）。 */
  selectionMode?: boolean;
  onToggleSelect?: (message: Message) => void;
}) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
  const longPressAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // 自己头像的挂件（设置 → 个性显示可关）。他人的挂件要逐个走 SSR 页面查，
  // 一条消息一次网络往返不现实，故只叠自己的。
  const pendantUrl = useSelfPendant();
  // 个性装扮页选的生效挂件/字体炫彩 —— 只在没有 per-message 装饰时顶上。
  const { widget: activeWidget, scope: activeScope } = useActiveWidget();
  const activeFontFx = useActiveFontFx();
  const msgDec = useMsgDecoration((message as any).decoration);
  const msgWidget = msgDec.widget;
  const msgBubbleId = msgDec.bubbleId;
  const msgFontId = msgDec.fontId;
  // 炫彩素材的优先级同挂件：逐条消息字体（40801）> 生效字体。
  // 生效字体要守作用范围（mine 只放自己的消息）；逐条消息那个与范围无关，是这条消息
  // 自带的装饰。
  const lineFontFx = msgDec.fontFx ?? (mine || activeScope === 'all' ? activeFontFx : null);
  // 量完气泡尺寸才知道放不放、放哪一段（见 useBubbleFontFx）。
  const fontFxAttr = useBubbleFontFx(lineFontFx, bubbleRef);
  // 渲染优先级:per-message 装饰（发送者自己的 QQ 挂件）> 生效挂件 > 自己的静态挂件。
  // 生效挂件的作用范围:mine → 只叠自己的消息;all → 连对方的一起叠。
  const lineWidget =
    msgWidget ?? (activeWidget && (mine || activeScope === 'all') ? activeWidget : null);
  // Deleted origin — prefer the explicit kind; fall back to the legacy boolean
  // (which always meant a WeQ delete). `qq` = QQ-native recall, not restorable.
  const resolvedKind: 'weq' | 'qq' | null = deletedKind ?? (deleted ? 'weq' : null);
  const isDeleted = resolvedKind !== null;
  const isQqDeleted = resolvedKind === 'qq';

  // Recall marker — the anti-recall trigger caught a QQ recall of this message;
  // its content is intact, so we DON'T veil it (unlike delete). We just show a
  // small "撤回" tag below the bubble naming who recalled it. `sameSender` = the
  // author recalled their own message; otherwise an admin recalled someone else's.
  // 乐观渲染的合并转发状态标识（发送中 / 已发送 / 发送失败）。该消息只活在前端
  // state 里，等 QQ 同步回真消息后自然消失。
  const optimistic = (
    message as { optimistic?: 'sending' | 'sent' | 'failed'; optimisticError?: string }
  ).optimistic;
  const optimisticText =
    optimistic === 'sending'
      ? '发送中…'
      : optimistic === 'failed'
        ? '发送失败'
        : optimistic === 'sent'
          ? '已发送'
          : null;
  const recall = (
    message as { recall?: { revokeUid: string; sameSender: boolean; recallTs: number } }
  ).recall;
  const recallText = !recall
    ? null
    : recall.sameSender
      ? mine
        ? '你撤回了这条消息'
        : '对方撤回了这条消息'
      : `${recallRevokerName?.trim() || '管理员'} 撤回了这条消息`;

  // 群精华角标：消息 seq 命中本地 group_essence 表（仅数据库，不联网）时，
  // 在气泡右下角打「四芒星 精华」标。
  const isEssence =
    conversation.type === 'group' &&
    message.msgSeq != null &&
    (conversation.group.essenceSeqs ?? []).includes(String(message.msgSeq));

  function clearLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' || event.button !== 0) {
      return;
    }
    const startPoint = { x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    longPressPointRef.current = startPoint;
    longPressAnchorRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.bottom,
    };
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      const anchorPoint = longPressAnchorRef.current ?? startPoint;
      selectMessageContent();
      onLongPress(anchorPoint, message);
      clearLongPress();
    }, 460);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = longPressPointRef.current;
    if (!point) {
      return;
    }
    if (Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) {
      clearLongPress();
    }
  }

  function selectMessageContent() {
    const content = bubbleRef.current?.querySelector('.message-content');
    if (!content?.textContent?.trim()) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function handleActionClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    action: MessageAction,
  ) {
    event.stopPropagation();
    if (!onAction || pendingActionId) {
      return;
    }

    setPendingActionId(action.id);
    try {
      await onAction(message, action);
    } finally {
      setPendingActionId((current) => (current === action.id ? null : current));
    }
  }

  // 卸载时清掉未触发的长按计时器。直接操作 ref，免得把每次渲染新建的
  // clearLongPress 当依赖。
  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    },
    [],
  );

  async function handleRestoreClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!onRestore || restoring) {
      return;
    }
    setRestoring(true);
    try {
      await onRestore(message.id);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div
      className={cn(
        'message-line',
        mine ? 'mine' : 'theirs',
        isDeleted && 'is-deleted',
        isQqDeleted && 'is-qq-deleted',
        selectionMode && 'selection-mode',
        selected && 'is-selected',
      )}
      data-message-id={message.id}
      onClick={
        selectionMode && onToggleSelect
          ? (event) => {
              event.stopPropagation();
              onToggleSelect(message);
            }
          : undefined
      }
      data-bubble={msgBubbleId || undefined}
      data-font={msgFontId || undefined}
      data-fontfx={fontFxAttr}
      data-widget={msgWidget?.animated ? msgWidget.itemId : undefined}
    >
      {selectionMode ? (
        <span className={cn('message-select-mark')} aria-hidden>
          {selected ? <Check size={13} strokeWidth={3.2} /> : null}
        </span>
      ) : null}
      {!mine ? (
        onAvatarClick ? (
          <button
            type="button"
            className={cn('message-avatar-button')}
            title="查看资料"
            aria-label={`查看 ${senderName} 的资料`}
            onClick={(event) => onAvatarClick(sender, { x: event.clientX, y: event.clientY })}
          >
            <PendantOverlay
              name={senderName}
              avatarUrl={senderAvatarUrl}
              seed={senderSeed}
              widget={lineWidget}
            />
          </button>
        ) : (
          <PendantOverlay
            name={senderName}
            avatarUrl={senderAvatarUrl}
            seed={senderSeed}
            widget={lineWidget}
          />
        )
      ) : null}
      <div
        ref={bubbleRef}
        className={cn('message-bubble', active && 'context-active')}
        onContextMenu={(event) => onContextMenu(event, message)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        onDragStart={(event) => event.preventDefault()}
      >
        {showSenderName ? (
          <span className={cn('message-name')}>
            {senderName}
            {(() => {
              const role = (sender as any).role;
              const isRoleBadge = role === 'owner' || role === 'admin';
              // 群头衔优先级：群主/管理员 > 自定义头衔/群等级
              const badgeText = isRoleBadge
                ? role === 'owner'
                  ? '群主'
                  : '管理员'
                : (sender as any).customTitle || (sender as any).levelName;
              if (!badgeText) return null;
              const levelBracket = (sender as any).levelBracket;
              const memberLevel = (sender as any).memberLevel;
              return (
                <small
                  className={cn(
                    'member-badge',
                    isRoleBadge ? role : '',
                    !isRoleBadge && levelBracket > 0 ? `level-${levelBracket}` : '',
                  )}
                >
                  {!isRoleBadge && memberLevel != null ? `Lv${memberLevel} · ` : ''}
                  {badgeText}
                </small>
              );
            })()}
            {senderKind === 'bot' ? (
              <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                <Bot size={12} strokeWidth={2.4} />
              </small>
            ) : null}
          </span>
        ) : null}
        {renderMessageWithRegistry(
          {
            message,
            conversation,
            sender,
            mine,
          },
          renderers,
        )}
        <SetEmojiReactions list={message.setEmojiList} />
        {isEssence ? (
          <span className={cn('weq-msg-essence-badge')} title="该消息为群精华">
            <Sparkle size={10} strokeWidth={2.6} />
            <span>精华</span>
          </span>
        ) : null}
        {recallText ? (
          <div className={cn('weq-msg-recall-tag')} title="防撤回已保留原消息">
            <RotateCcw size={12} />
            <span>{recallText}</span>
          </div>
        ) : null}
        {optimisticText ? (
          <div
            className={cn('weq-msg-optimistic-tag', `is-${optimistic}`)}
            title={
              optimistic === 'failed'
                ? (message as { optimisticError?: string }).optimisticError || '发送失败'
                : '这条消息还没同步回来，先乐观显示'
            }
          >
            {optimistic === 'failed' ? <X size={12} /> : <Clock size={12} />}
            <span>{optimisticText}</span>
          </div>
        ) : null}
        {isDeleted ? (
          <div
            className={cn('weq-msg-deleted-veil')}
            aria-label={isQqDeleted ? 'QQ删除的消息' : '已删除的消息'}
          >
            <span className={cn('weq-msg-deleted-badge')}>{isQqDeleted ? 'QQ删除' : '已删除'}</span>
            {!isQqDeleted && onRestore ? (
              <button
                type="button"
                className={cn('weq-msg-restore')}
                title="恢复这条消息"
                disabled={restoring}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  void handleRestoreClick(event);
                }}
              >
                <RotateCcw size={13} />
                <span>{restoring ? '恢复中…' : '恢复'}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {message.actions?.length ? (
          <div className={cn('message-actions')}>
            {message.actions.map((action) => {
              const pending = pendingActionId === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  className={cn(
                    'message-action-button',
                    action.style === 'primary' && 'primary',
                    action.style === 'danger' && 'danger',
                    pending && 'pending',
                  )}
                  aria-busy={pending || undefined}
                  disabled={Boolean(pendingActionId)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    void handleActionClick(event, action);
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {mine ? (
        <PendantOverlay
          name={senderName}
          avatarUrl={senderAvatarUrl}
          seed={senderSeed}
          widget={lineWidget}
          fallbackUrl={pendantUrl}
        />
      ) : null}
    </div>
  );
}
