// @ts-nocheck
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Check, LoaderCircle, RotateCcw, Sparkle, TriangleAlert, X } from 'lucide-react';
import { renderMessageWithRegistry, type MessageRenderer } from './messageRenderers';
import { Avatar } from './primitives';
import type { Conversation, Message, MessageAction, User } from './types';
import { cn } from './classNames';
import { SetEmojiReactions, type ReactionRemoval } from '../../components/SetEmojiReactions';
import { MessageIntentSense } from '../../components/intentSense/MessageIntentSense';
import { useSelfPendant } from '../../hooks/useSelfPendant';
import { useActiveFontFx, useActiveWidget } from '../../hooks/useActiveWidget';
import { useBubbleFontFx } from '../../hooks/useBubbleFontFx';
import { useMsgDecoration } from '../../hooks/useMsgDecoration';
import { MessageProvenance } from '../../components/MessageProvenance';
import { GroupMessageBadge } from '../../components/GroupMessageBadge';
import { messageHasIntentText } from '../../lib/intentTimeline';
import '../../styles/chat-interactions.css';
import '../../styles/composer-reedit.css';

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
  hideDeletedBadge,
  recallRevokerName,
  hideRecallTag,
  onRestore,
  onContextMenu,
  onLongPress,
  onAction,
  onReedit,
  onAvatarClick,
  onAvatarContextMenu,
  selected,
  selectionMode,
  onToggleSelect,
  reactionRemoval,
  repeatAction,
  pendingAction,
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
   * 宿主自绘「已删除 / QQ删除」标识时置位：只保留气泡本身那种半透明已删除观感
   * （见 `.message-line.is-deleted .message-bubble`），不再在气泡右下角叠那枚小标签。
   * 「删除列表」面板用它 —— 列表本身就在讲已删除，徽标是重复信息。
   */
  hideDeletedBadge?: boolean;
  /**
   * Recall reviser's display name — shown in the 撤回 tag when an admin recalled
   * someone else's message (`recall.sameSender === false`). Resolved by the
   * parent from `message.recall.revokeUid`.
   */
  recallRevokerName?: string;
  /**
   * 宿主已在气泡上方自绘撤回信息（撤回者 + 时间）时置位：不再在气泡下方渲染
   * `.weq-msg-recall-tag`，避免同一件事在一行里出现两遍 / 互相重叠。
   */
  hideRecallTag?: boolean;
  /** Restore a WeQ-deleted message (only used when `deleted`). */
  onRestore?: (msgId: string) => Promise<void>;
  onContextMenu: (event: ReactMouseEvent, message: Message) => void;
  onLongPress: (point: { x: number; y: number }, message: Message) => void;
  onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
  onReedit?: (message: Message) => Promise<boolean>;
  onAvatarClick?: (sender: User, anchor: { x: number; y: number }) => void;
  /** 右键头像：弹出「@他 / 戳一戳」轻互动菜单。 */
  onAvatarContextMenu?: (event: ReactMouseEvent, sender: User) => void;
  /** 多选：这一行被选中（整行高亮 + 勾选标）。 */
  selected?: boolean;
  /** 多选模式：点击整行切换选中（而不是触发右键菜单）。 */
  selectionMode?: boolean;
  onToggleSelect?: (message: Message, event?: ReactMouseEvent) => void;
  reactionRemoval?: ReactionRemoval;
  repeatAction?: import('react').ReactNode;
  pendingAction?: import('react').ReactNode;
}) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
  const longPressAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [reeditArmed, setReeditArmed] = useState(false);
  const [reeditBusy, setReeditBusy] = useState(false);
  const reeditPending = useRef(false);
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
  // 未同步入库的发送消息：发送中仅显示旁侧圈圈，正常回执后隐藏，失败才显示下方提示。
  const optimistic = message.optimistic;
  const optimisticRejected = message.optimisticRejected;
  const optimisticText =
    optimistic === 'failed'
      ? '发送失败'
      : optimistic === 'sent' && optimisticRejected
        ? '可能未送达'
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
  useEffect(
    () => setReeditArmed(false),
    [message.id, optimistic, optimisticRejected, recall?.recallTs],
  );
  const StatusTag = mine && onReedit && !selectionMode ? 'button' : 'div';
  const reeditClass =
    StatusTag === 'button' ? cn('weq-msg-reedit-trigger', reeditArmed && 'is-armed') : undefined;
  async function activateReedit(event: ReactMouseEvent) {
    event.stopPropagation();
    if (reeditPending.current) return;
    if (!reeditArmed) {
      setReeditArmed(true);
      return;
    }
    reeditPending.current = true;
    setReeditBusy(true);
    try {
      if (await onReedit?.(message)) setReeditArmed(false);
    } finally {
      reeditPending.current = false;
      setReeditBusy(false);
    }
  }
  const statusProps =
    StatusTag === 'button'
      ? {
          type: 'button' as const,
          onClick: activateReedit,
          disabled: reeditBusy,
          'aria-busy': reeditBusy,
        }
      : {};

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
    if (selectionMode || event.pointerType === 'mouse' || event.button !== 0) {
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
    if (!content || (!content.textContent?.trim() && !content.querySelector('img, [role="img"]'))) {
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

  const SelfAvatar = onAvatarClick ? 'button' : 'span';
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
      data-weq-select-id={selectionMode ? message.id : undefined}
      tabIndex={selectionMode ? 0 : undefined}
      onClickCapture={
        selectionMode && onToggleSelect
          ? (event) => {
              event.stopPropagation();
              event.preventDefault();
              onToggleSelect(message, event);
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
            onContextMenu={
              onAvatarContextMenu ? (event) => onAvatarContextMenu(event, sender) : undefined
            }
          >
            <PendantOverlay
              name={senderName}
              avatarUrl={senderAvatarUrl}
              seed={senderSeed}
              widget={lineWidget}
            />
          </button>
        ) : (
          <span
            className={cn('message-avatar-wrap')}
            onContextMenu={
              onAvatarContextMenu ? (event) => onAvatarContextMenu(event, sender) : undefined
            }
          >
            <PendantOverlay
              name={senderName}
              avatarUrl={senderAvatarUrl}
              seed={senderSeed}
              widget={lineWidget}
            />
          </span>
        )
      ) : null}
      {optimistic === 'sending' ? (
        <span className="weq-message-sending" role="status" aria-label="发送中">
          <LoaderCircle size={16} aria-hidden />
        </span>
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
        <div className="weq-message-heading">
          {showSenderName ? (
            <span className={cn('message-name')}>
              {conversation.type === 'group' ? (
                <GroupMessageBadge groupId={conversation.group.identityValue} member={sender} />
              ) : null}
              {senderName}
              {senderKind === 'bot' ? (
                <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                  <Bot size={12} strokeWidth={2.4} />
                </small>
              ) : null}
            </span>
          ) : null}
          <MessageProvenance message={message} />
        </div>
        {repeatAction ? (
          <div className="weq-repeat-content">
            {renderMessageWithRegistry({ message, conversation, sender, mine }, renderers)}
            {repeatAction}
          </div>
        ) : (
          renderMessageWithRegistry({ message, conversation, sender, mine }, renderers)
        )}
        {/* 贴表情：悬停某一枚会弹出回应人名单（靠在线 QQ 实时查，见 0x9083_1）；
            只有群聊 + 有会话内序号时才可查。 */}
        <SetEmojiReactions
          list={message.setEmojiList}
          groupId={conversation.type === 'group' ? conversation.group.identityValue : null}
          sequence={Number((message as { msgSeq?: unknown }).msgSeq) || 0}
          removal={selectionMode ? undefined : reactionRemoval}
        />
        {pendingAction}
        {isEssence ? (
          <span className={cn('weq-msg-essence-badge')} title="该消息为群精华">
            <Sparkle size={10} strokeWidth={2.6} />
            <span>精华</span>
          </span>
        ) : null}
        {recallText && !hideRecallTag ? (
          <StatusTag
            {...statusProps}
            className={cn('weq-msg-recall-tag', reeditClass)}
            title="防撤回已保留原消息"
          >
            <RotateCcw size={12} />
            <span>{reeditArmed && reeditClass ? '重新编辑' : recallText}</span>
          </StatusTag>
        ) : null}
        {optimisticText ? (
          <StatusTag
            {...statusProps}
            className={cn(
              'weq-msg-optimistic-tag',
              reeditClass,
              `is-${optimistic}`,
              optimisticRejected && 'is-rejected',
            )}
            title={
              optimistic === 'failed'
                ? (message as { optimisticError?: string }).optimisticError || '发送失败'
                : optimisticRejected
                  ? '服务端回了成功但没有分配消息序号，这条很可能被静默丢弃了 —— 请让对方确认是否收到'
                  : '这条消息还没同步回来，先乐观显示'
            }
          >
            {optimistic === 'failed' ? <X size={12} /> : <TriangleAlert size={12} />}
            <span>{reeditArmed && reeditClass ? '重新编辑' : optimisticText}</span>
          </StatusTag>
        ) : null}
        {/* 意图感知：最新可分析文本（含自己）展示胶囊，悬停文本消息出弹层。
            数据与悬停监听都在组件内部（经 IntentSenseContext），关掉功能时渲染 null。 */}
        <MessageIntentSense
          msgId={String(message.id)}
          bubbleRef={bubbleRef}
          analyzable={messageHasIntentText(message)}
        />
        {isDeleted && !hideDeletedBadge ? (
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
        <SelfAvatar
          className={cn(onAvatarClick ? 'message-avatar-button' : 'message-avatar-wrap', 'is-self')}
          {...(onAvatarClick
            ? {
                type: 'button',
                title: '查看资料',
                'aria-label': `查看 ${senderName} 的资料`,
                onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onAvatarClick(
                    sender,
                    event.detail
                      ? { x: event.clientX, y: event.clientY }
                      : { x: rect.left, y: rect.bottom },
                  );
                },
              }
            : {})}
          onContextMenu={
            onAvatarContextMenu ? (event) => onAvatarContextMenu(event, sender) : undefined
          }
        >
          <PendantOverlay
            name={senderName}
            avatarUrl={senderAvatarUrl}
            seed={senderSeed}
            widget={lineWidget}
            fallbackUrl={pendantUrl}
          />
        </SelfAvatar>
      ) : null}
    </div>
  );
}
