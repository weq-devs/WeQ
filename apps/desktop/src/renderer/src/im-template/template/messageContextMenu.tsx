import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MessageMenuFeedbackContext } from '../../lib/messageMenuFeedback';
import { SmilePlus } from 'lucide-react';
import { QqIcon } from '../../lib/qqIcons';
import type { Message } from './types';
import { cn } from './classNames';
import { canRepeatMessage } from '../../lib/messageRepeat';
import { useSurfaceOutside } from '../../lib/surfaceOutside';
import { useTabActive } from '../../components/RetainedTabs';
import { IS_WEB } from '../../lib/target';
import { VoiceTranscribeMenuAction } from '../../components/VoiceTranscribeMenuAction';
import { TextMarkdownMenuAction } from '../../components/TextMarkdownMenuAction';
import type { MessageMediaTarget } from '../../../../shared/message_media';
import { DEFAULT_REACTIONS, type ReactionItem } from '../../lib/reactionItems';
import '../../styles/message-context-menu.css';

export type MessageContextMenuState = {
  message: Message;
  x: number;
  y: number;
  downloadUrl?: string;
  imageUrl?: string;
  favoriteEmojiUrl?: string;
  mediaTarget?: MessageMediaTarget;
  clipboard?: { text: string; html: string };
  variant?: 'desktop' | 'mobile';
  anchorOffsetX?: number;
  anchorOffsetY?: number;
  originElement?: HTMLElement | null;
};

type Props = {
  state: MessageContextMenuState;
  onClose?: () => void;
  onCopy: (message: Message) => void | Promise<void>;
  onForward?: (message: Message) => void;
  onMultiSelect?: (message: Message) => void;
  onReply?: (message: Message) => void;
  replyBlockedReason?: string | null;
  onRepeat?: (message: Message) => void;
  repeatBlockedReason?: string | null;
  onRecall?: (message: Message) => void;
  recallBlockedReason?: string | null;
  recallCount?: number;
  onAddToComposition?: (message: Message) => void;
  onExport?: (message: Message) => void;
  exportLabel?: string;
  exportBlockedReason?: string;
  onViewDecoration?: (message: Message) => void;
  onEditRaw?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  deleteLabel?: string;
  onDownloadImage?: (url: string, message: Message) => void;
  onSaveMedia?: () => void;
  downloadDisabled?: boolean;
  onReact?: (message: Message) => void;
  onSetReaction?: (message: Message, code: string, isSet: boolean) => void;
  reactBlockedReason?: string | null;
  reactions?: readonly ReactionItem[];
  essenceAction?: ReactNode;
  todoAction?: ReactNode;
  intentAction?: ReactNode;
  favoriteEmojiAction?: ReactNode;
  revealAction?: ReactNode;
  unavailableReason?: string;
};

export function MessageContextMenu({
  state,
  onClose,
  onCopy,
  onForward,
  onMultiSelect,
  onReply,
  replyBlockedReason,
  onRepeat,
  repeatBlockedReason,
  onRecall,
  recallBlockedReason,
  recallCount,
  onAddToComposition,
  onExport,
  exportLabel = '导出',
  exportBlockedReason,
  onViewDecoration,
  onEditRaw,
  onDelete,
  deleteLabel = '本地删除',
  onDownloadImage,
  onSaveMedia,
  downloadDisabled = false,
  onReact,
  onSetReaction,
  reactBlockedReason,
  reactions = DEFAULT_REACTIONS,
  essenceAction,
  todoAction,
  intentAction,
  favoriteEmojiAction,
  revealAction,
  unavailableReason,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [feedbackHost, setFeedbackHost] = useState<HTMLDivElement | null>(null);
  const active = useTabActive();
  useSurfaceOutside(menuRef, onClose, active);
  const message = state.message;
  const decoration = message.decoration;
  const hasDecoration =
    decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId);

  useEffect(() => {
    const menu = menuRef.current;
    const first =
      menu?.querySelector<HTMLButtonElement>('.message-menu-main button:not(:disabled)') ??
      menu?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, [message.id]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const place = () => {
      const rect = el.getBoundingClientRect();
      const left = state.variant === 'mobile' ? state.x - rect.width / 2 : state.x;
      el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [state.x, state.y, state.variant]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const menu = menuRef.current;
    if (!menu) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      state.originElement?.focus({ preventScroll: true });
      return;
    }
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const current = document.activeElement as HTMLButtonElement;
    const rows = [...menu.querySelectorAll<HTMLElement>('[data-menu-row]')]
      .map((row) =>
        [...row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
          (button) => getComputedStyle(button).display !== 'none',
        ),
      )
      .filter((row) => row.length);
    const rowIndex = rows.findIndex((row) => row.includes(current));
    const row = rows[rowIndex] ?? [];
    const column = Math.max(0, row.indexOf(current));
    let next: HTMLButtonElement | undefined;
    if (event.key === 'Home') next = buttons[0];
    if (event.key === 'End') next = buttons.at(-1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      next = row[(column + (event.key === 'ArrowRight' ? 1 : row.length - 1)) % row.length];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target =
        rows[(rowIndex + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
      next = target?.[Math.min(column, target.length - 1)];
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  function action(
    label: string,
    icon: ReactNode,
    run: (() => void) | undefined,
    reason?: string | null,
    danger = false,
    hint?: string,
  ) {
    return (
      <button
        type="button"
        role="menuitem"
        aria-label={label}
        title={reason || hint || label}
        disabled={!run || Boolean(reason)}
        data-danger={danger || undefined}
        onClick={run}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }
  const slot = (content: ReactNode, label?: string) => (
    <div className="message-action-slot" title={label}>
      {content}
    </div>
  );
  const save =
    onSaveMedia ||
    (state.downloadUrl && onDownloadImage
      ? () => onDownloadImage(state.downloadUrl!, message)
      : undefined);

  return (
    <MessageMenuFeedbackContext.Provider value={feedbackHost}>
      <div
        ref={menuRef}
        role="menu"
        aria-label="消息操作"
        data-hover-delay="0"
        className={cn(
          'message-context-menu',
          'message-menu-v2',
          state.variant === 'mobile' && 'message-menu-touch',
        )}
        style={{ left: state.x, top: state.y }}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        {onReact ? (
          <div
            className="message-reaction-strip"
            data-menu-row
            role="group"
            aria-label="快捷贴表情"
          >
            {reactions.map((reaction) => {
              const selected = Boolean(
                message.setEmojiList?.some(
                  (item) => item.emojiId === reaction.code && item.isSelfSet,
                ),
              );
              const label = `${selected ? '取消贴表情' : '贴表情'}：${reaction.title}`;
              return (
                <button
                  key={reaction.code}
                  type="button"
                  aria-label={label}
                  aria-pressed={selected}
                  title={reactBlockedReason || label}
                  disabled={Boolean(reactBlockedReason) || !onSetReaction}
                  onClick={() => onSetReaction?.(message, reaction.code, !selected)}
                >
                  {reaction.item.glyph ? (
                    <span>{reaction.item.glyph}</span>
                  ) : (
                    <img src={reaction.item.src ?? ''} alt="" draggable={false} />
                  )}
                </button>
              );
            })}
            <button
              type="button"
              aria-label="更多表情"
              title={reactBlockedReason || '更多表情'}
              disabled={Boolean(reactBlockedReason)}
              onClick={() => onReact(message)}
            >
              <SmilePlus size={22} />
            </button>
          </div>
        ) : null}
        <div className="message-menu-main">
          <div data-menu-row>
            {action('复制', <QqIcon name="copy" size={17} />, () => void onCopy(message))}
            {onForward || unavailableReason
              ? action(
                  '转发',
                  <QqIcon name="share" size={17} />,
                  onForward && (() => onForward(message)),
                  !onForward ? unavailableReason : null,
                )
              : null}
          </div>
          <div data-menu-row>
            {onMultiSelect
              ? action('多选', <QqIcon name="multiSelect" size={17} />, () =>
                  onMultiSelect(message),
                )
              : null}
            {onReply || unavailableReason
              ? action(
                  '引用',
                  <QqIcon name="reply" size={17} />,
                  onReply && (() => onReply(message)),
                  !onReply ? unavailableReason : replyBlockedReason,
                )
              : null}
          </div>
        </div>
        <div className="message-action-row" data-menu-row role="group" aria-label="媒体操作">
          {slot(<VoiceTranscribeMenuAction message={message} onClose={onClose} />)}
          {save
            ? action(
                IS_WEB ? '保存到服务器' : '另存为',
                <QqIcon name="download" size={17} />,
                save,
                downloadDisabled ? '正在准备媒体保存，请稍候' : null,
                false,
                state.mediaTarget
                  ? `${IS_WEB ? '保存到服务器' : '另存为'}：${state.mediaTarget.label}`
                  : undefined,
              )
            : null}
        </div>
        <div className="message-action-row" data-menu-row role="group" aria-label="消息互动">
          {(onRepeat || unavailableReason) && canRepeatMessage(message)
            ? action(
                '+1',
                <span className="message-plus-one" aria-hidden>
                  +1
                </span>,
                onRepeat && (() => onRepeat(message)),
                !onRepeat ? unavailableReason : repeatBlockedReason,
              )
            : null}
          {onRecall || unavailableReason
            ? action(
                recallCount ? `撤回所选 ${recallCount} 条消息` : '撤回',
                <QqIcon name="recall" size={17} />,
                onRecall && (() => onRecall(message)),
                !onRecall ? unavailableReason : recallBlockedReason,
              )
            : null}
          {slot(essenceAction)}
          {slot(todoAction, '设为群待办')}
        </div>
        <div className="message-action-row" data-menu-row role="group" aria-label="保存与分析">
          {onAddToComposition || unavailableReason
            ? action(
                '添加到素材库',
                <QqIcon name="collection" size={17} />,
                onAddToComposition && (() => onAddToComposition(message)),
                !onAddToComposition ? unavailableReason : null,
              )
            : null}
          {onExport
            ? action(
                exportLabel,
                <QqIcon name="exportFile" size={17} />,
                () => onExport(message),
                exportBlockedReason,
              )
            : null}
          {slot(intentAction)}
          {hasDecoration && onViewDecoration
            ? action('查看装扮', <QqIcon name="palette" size={17} />, () =>
                onViewDecoration(message),
              )
            : null}
        </div>
        <div className="message-action-row" data-menu-row role="group" aria-label="显示与本地记录">
          {slot(
            favoriteEmojiAction || <TextMarkdownMenuAction message={message} onClose={onClose} />,
          )}
          {slot(revealAction)}
          {onEditRaw || unavailableReason
            ? action(
                '修改本地记录',
                <QqIcon name="edit" size={17} />,
                onEditRaw && (() => onEditRaw(message)),
                !onEditRaw ? unavailableReason : null,
              )
            : null}
          {onDelete || unavailableReason
            ? action(
                deleteLabel,
                <QqIcon name="trash" size={17} />,
                onDelete && (() => onDelete(message)),
                !onDelete ? unavailableReason : null,
                true,
              )
            : null}
        </div>
        <div className="message-menu-feedback" ref={setFeedbackHost} />
      </div>
    </MessageMenuFeedbackContext.Provider>
  );
}
