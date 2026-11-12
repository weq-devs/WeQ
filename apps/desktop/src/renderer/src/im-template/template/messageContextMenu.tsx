import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  BookmarkPlus,
  Copy,
  Download,
  Forward,
  ListChecks,
  Palette,
  Pencil,
  Repeat2,
  Reply,
  SmilePlus,
  Trash2,
  Undo2,
} from 'lucide-react';
import { MessageMenuFeedbackContext } from '../../lib/messageMenuFeedback';
import { MessageMenuButton, MessageMenuContext } from '../../components/MessageMenuButton';
import type { Message } from './types';
import { cn } from './classNames';
import { canRepeatMessage } from '../../lib/messageRepeat';
import { messageMediaTarget } from '../../lib/messageMediaTarget';
import { useSurfaceOutside } from '../../lib/surfaceOutside';
import { useTabActive } from '../../components/RetainedTabs';
import { IS_WEB } from '../../lib/target';
import { VoiceTranscribeMenuAction } from '../../components/VoiceTranscribeMenuAction';
import { TextMarkdownMenuAction } from '../../components/TextMarkdownMenuAction';
import type { MessageMediaTarget } from '../../../../shared/message_media';
import {
  DEFAULT_REACTIONS,
  quickReactionCapacity,
  type ReactionItem,
} from '../../lib/reactionItems';
import type { ForwardExportTarget } from '../../lib/messageForwardTarget';
import '../../styles/message-context-menu.css';

export type MessageContextMenuState = {
  message: Message;
  x: number;
  y: number;
  downloadUrl?: string;
  imageUrl?: string;
  favoriteEmojiUrl?: string;
  mediaTarget?: MessageMediaTarget;
  forwardTarget?: ForwardExportTarget;
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
  onAddToComposition?: (message: Message) => void;
  onExport?: (message: Message) => void;
  exportBlockedReason?: string;
  onViewDecoration?: (message: Message) => void;
  onEditRaw?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  deleteLabel?: string;
  onDownloadImage?: (url: string, message: Message) => void;
  onSaveMedia?: () => void;
  downloadDisabled?: boolean;
  onReact?: (message: Message) => void;
  showReactions?: boolean;
  onSetReaction?: (message: Message, code: string, isSet: boolean) => void;
  reactBlockedReason?: string | null;
  reactions?: readonly ReactionItem[];
  essenceAction?: ReactNode;
  todoAction?: ReactNode;
  intentAction?: ReactNode;
  favoriteEmojiAction?: ReactNode;
  revealAction?: ReactNode;
};

interface MenuAction {
  id: string;
  label: string;
  icon: ReactNode;
  applicable: boolean;
  reason?: string | null;
  run?: () => void;
  danger?: boolean;
}

export function MessageContextMenu(props: Props) {
  const { state, onClose, onCopy, reactions = DEFAULT_REACTIONS } = props;
  const message = state.message;
  const originElement = state.originElement;
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedIndex = useRef(0);
  const restoreFocus = useRef(true);
  const [feedbackHost, setFeedbackHost] = useState<HTMLDivElement | null>(null);
  const [reactionCapacity, setReactionCapacity] = useState(0);
  const showReactions = (props.showReactions ?? true) && Boolean(props.onReact);
  useSurfaceOutside(menuRef, onClose, useTabActive());

  const buttons = useCallback(
    () =>
      [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
        (button) => getComputedStyle(button).display !== 'none',
      ),
    [],
  );

  useEffect(() => {
    restoreFocus.current = true;
    const menu = menuRef.current;
    const first =
      menu?.querySelector<HTMLButtonElement>('.message-menu-main button') ?? buttons()[0];
    first?.focus({ preventScroll: true });
    const observer = new MutationObserver(() => {
      if (document.activeElement === document.body && restoreFocus.current)
        buttons()[Math.min(focusedIndex.current, buttons().length - 1)]?.focus({
          preventScroll: true,
        });
    });
    if (menu) observer.observe(menu, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      queueMicrotask(() => {
        if (
          restoreFocus.current &&
          document.activeElement === document.body &&
          originElement?.isConnected
        )
          originElement.focus({ preventScroll: true });
      });
    };
  }, [message.id, originElement, buttons]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const place = () => {
      const rect = el.getBoundingClientRect();
      const strip = el.querySelector<HTMLElement>('.message-reaction-strip');
      const capacity = quickReactionCapacity(strip?.getBoundingClientRect().width ?? 0);
      const focused = [
        ...(strip?.querySelectorAll('button[role="menuitemcheckbox"]') ?? []),
      ].indexOf(document.activeElement as HTMLButtonElement);
      if (focused >= capacity && focused >= 0)
        strip
          ?.querySelector<HTMLButtonElement>('[aria-label="更多表情"]')
          ?.focus({ preventScroll: true });
      setReactionCapacity(capacity);
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
  }, [state.x, state.y, state.variant, showReactions]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      restoreFocus.current = false;
      let next = state.originElement;
      if (event.key === 'Tab') {
        const order = [
          ...document.querySelectorAll<HTMLElement>(
            'button, a[href], input, textarea, select, [tabindex]',
          ),
        ].filter(
          (el) =>
            el.tabIndex >= 0 &&
            !el.matches(':disabled') &&
            !menuRef.current?.contains(el) &&
            el.getClientRects().length > 0,
        );
        const origin = next;
        const direction = event.shiftKey
          ? Node.DOCUMENT_POSITION_PRECEDING
          : Node.DOCUMENT_POSITION_FOLLOWING;
        next =
          (event.shiftKey ? order.toReversed() : order).find(
            (element) => origin && Boolean(origin.compareDocumentPosition(element) & direction),
          ) ?? null;
      }
      onClose?.();
      next?.focus({ preventScroll: true });
      return;
    }
    const all = buttons();
    const current = document.activeElement as HTMLButtonElement;
    const rows = [
      ...(menuRef.current?.querySelectorAll('.message-reaction-strip, .message-menu-group') ?? []),
    ].flatMap((group) => {
      const items = [...group.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
        all.includes(button),
      );
      if (group.classList.contains('message-reaction-strip')) return items.length ? [items] : [];
      return items.flatMap((_, index) => (index % 2 === 0 ? [items.slice(index, index + 2)] : []));
    });
    const rowIndex = rows.findIndex((row) => row.includes(current));
    const row = rows[rowIndex] ?? [];
    const column = Math.max(0, row.indexOf(current));
    let next: HTMLButtonElement | undefined;
    if (event.key === 'Home') next = all[0];
    if (event.key === 'End') next = all.at(-1);
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

  const icon = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;
  const action = (
    id: string,
    label: string,
    image: ReactNode,
    run: (() => void) | undefined,
    reason?: string | null,
    applicable = Boolean(run),
    danger = false,
  ): MenuAction => ({ id, label, icon: image, run, reason, applicable, danger });
  const call = (run: ((message: Message) => void) | undefined) => run && (() => run(message));
  const render = (items: MenuAction[]) =>
    items
      .filter((item) => item.applicable)
      .map((item) => (
        <MessageMenuButton
          key={item.id}
          aria-label={item.label}
          title={item.reason || item.label}
          disabled={!item.run || Boolean(item.reason)}
          data-danger={item.danger || undefined}
          onClick={item.run}
        >
          {item.icon}
          <span>{item.label}</span>
        </MessageMenuButton>
      ));
  const save =
    props.onSaveMedia ??
    (state.downloadUrl && props.onDownloadImage
      ? () => props.onDownloadImage?.(state.downloadUrl!, message)
      : undefined);
  const media = state.forwardTarget
    ? undefined
    : (state.mediaTarget ?? messageMediaTarget(message));
  const decoration = message.decoration;
  const hasDecoration = Boolean(
    decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId),
  );

  return (
    <MessageMenuContext.Provider value={true}>
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
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLButtonElement)
              focusedIndex.current = buttons().indexOf(event.target);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <div className="message-menu-primary">
            {showReactions && (
              <div className="message-reaction-strip" role="group" aria-label="快捷贴表情">
                {reactions.slice(0, reactionCapacity).map((reaction) => {
                  const selected = Boolean(
                    message.setEmojiList?.some(
                      (item) => item.emojiId === reaction.code && item.isSelfSet,
                    ),
                  );
                  const label = `${selected ? '取消贴表情' : '贴表情'}：${reaction.title}`;
                  return (
                    <MessageMenuButton
                      key={reaction.code}
                      role="menuitemcheckbox"
                      aria-label={label}
                      aria-checked={selected}
                      aria-pressed={selected}
                      title={props.reactBlockedReason || label}
                      disabled={Boolean(props.reactBlockedReason) || !props.onSetReaction}
                      onClick={() => props.onSetReaction?.(message, reaction.code, !selected)}
                    >
                      {reaction.item.glyph ? (
                        <span>{reaction.item.glyph}</span>
                      ) : (
                        <img
                          src={reaction.item.src ?? ''}
                          alt=""
                          draggable={false}
                          width={24}
                          height={24}
                        />
                      )}
                    </MessageMenuButton>
                  );
                })}
                <MessageMenuButton
                  aria-label="更多表情"
                  title={props.reactBlockedReason || '更多表情'}
                  disabled={Boolean(props.reactBlockedReason)}
                  onClick={() => props.onReact?.(message)}
                >
                  <SmilePlus {...icon} />
                </MessageMenuButton>
              </div>
            )}
            <div
              className="message-menu-group message-menu-main"
              role="group"
              aria-label="基础操作"
            >
              {render([
                action('copy', '复制', <Copy {...icon} />, () => void onCopy(message)),
                action(
                  'reply',
                  '引用',
                  <Reply {...icon} />,
                  call(props.onReply),
                  props.replyBlockedReason,
                ),
                action('forward', '转发', <Forward {...icon} />, call(props.onForward)),
                action(
                  'repeat',
                  '+1',
                  <Repeat2 {...icon} />,
                  call(props.onRepeat),
                  props.repeatBlockedReason,
                  Boolean(props.onRepeat) && canRepeatMessage(message),
                ),
                action('select', '多选', <ListChecks {...icon} />, call(props.onMultiSelect)),
                action(
                  'collect',
                  '添加到素材库',
                  <BookmarkPlus {...icon} />,
                  call(props.onAddToComposition),
                ),
              ])}
            </div>
            <div className="message-menu-group" role="group" aria-label="内容处理与保存">
              <div className="message-menu-slot">
                {media?.kind === 'ptt' ? (
                  <VoiceTranscribeMenuAction message={message} target={media} onClose={onClose} />
                ) : !media && !state.forwardTarget ? (
                  <TextMarkdownMenuAction message={message} onClose={onClose} />
                ) : null}
              </div>
              <div className="message-menu-slot">
                {['pic', 'emoji', 'mface'].includes(media?.kind ?? '')
                  ? props.favoriteEmojiAction
                  : null}
              </div>
              <div className="message-save-action">
                {render([
                  state.forwardTarget
                    ? action(
                        'export',
                        '导出',
                        <Download {...icon} />,
                        call(props.onExport),
                        props.exportBlockedReason,
                      )
                    : action(
                        'save',
                        IS_WEB ? '保存到服务器' : '另存为',
                        <Download {...icon} />,
                        save,
                        props.downloadDisabled ? '正在准备媒体保存，请稍候' : null,
                      ),
                ])}
              </div>
              <div className="message-reveal-action">{props.revealAction}</div>
              {render([
                action(
                  'decoration',
                  '查看装扮',
                  <Palette {...icon} />,
                  call(props.onViewDecoration),
                  null,
                  hasDecoration && Boolean(props.onViewDecoration),
                ),
              ])}
              <div className="message-menu-slot">{props.intentAction}</div>
            </div>
            <div className="message-menu-group" role="group" aria-label="群操作">
              <div className="message-menu-slot">{props.essenceAction}</div>
              <div className="message-menu-slot">{props.todoAction}</div>
            </div>
            <div className="message-menu-group" role="group" aria-label="本地编辑">
              {render([
                action('edit', '修改本地记录', <Pencil {...icon} />, call(props.onEditRaw)),
              ])}
            </div>
            <div className="message-menu-group" role="group" aria-label="撤回与删除">
              {render([
                action(
                  'recall',
                  '撤回',
                  <Undo2 {...icon} />,
                  call(props.onRecall),
                  props.recallBlockedReason,
                  Boolean(props.onRecall),
                  true,
                ),
                action(
                  'delete',
                  props.deleteLabel ?? '本地删除',
                  <Trash2 {...icon} />,
                  call(props.onDelete),
                  null,
                  Boolean(props.onDelete),
                  true,
                ),
              ])}
            </div>
          </div>
          <div className="message-menu-feedback" ref={setFeedbackHost} />
        </div>
      </MessageMenuFeedbackContext.Provider>
    </MessageMenuContext.Provider>
  );
}
