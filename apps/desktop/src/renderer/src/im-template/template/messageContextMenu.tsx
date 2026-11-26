import {
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { formatDateTime } from '@weq/time';
import {
  BookmarkPlus,
  Braces,
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
import { NumericText } from '../../components/NumericText';
import { MessageMenuButton } from '../../components/MessageMenuButton';
import { MessageMenuContext } from '../../components/MessageMenuButton.shared';
import { useToastApi } from '../../components/Toast.shared';
import { messageSequence, showsRoamingSource } from '../../components/MessageProvenance.shared';
import type { Message } from './types';
import { cn } from './classNames';
import { copyTextToClipboard } from './clipboard';
import { canRepeatMessage } from '../../lib/messageRepeat';
import { forwardContentBlockReason } from '../../lib/sequentialForward';
import { parseFlashShareCode } from '../../lib/flashShare';
import { messageMediaTarget } from '../../lib/messageMediaTarget';
import { useSurfaceOutside } from '../../lib/surfaceOutside';
import { useSurfaceRemovalFade } from '../../hooks/useSurfaceRemovalFade';
import { useTabPanelMotion } from '../../hooks/useTabPanelMotion';
import { OverlayLayerContext, useOverlayLayerScope } from '../../lib/overlayStack';
import { useRenderDocument } from '../../lib/renderDocument';
import { useTabActive } from '../../components/RetainedTabs.shared';
import { VoiceTranscribeMenuAction } from '../../components/VoiceTranscribeMenuAction';
import { TextMarkdownMenuAction } from '../../components/TextMarkdownMenuAction';
import type { MessageMediaTarget } from '../../../../shared/message_media';
import {
  DEFAULT_REACTIONS,
  quickReactionCapacity,
  type ReactionItem,
} from '../../lib/reactionItems';
import type { ForwardCardTarget } from '@weq/service';
import '../../styles/message-context-menu.css';

export type MessageContextMenuState = {
  message: Message;
  x: number;
  y: number;
  downloadUrl?: string;
  imageUrl?: string;
  favoriteEmojiUrl?: string;
  mediaTarget?: MessageMediaTarget;
  forwardTarget?: ForwardCardTarget;
  clipboard?: { text: string; html: string };
  variant?: 'desktop' | 'mobile';
  anchorOffsetX?: number;
  anchorOffsetY?: number;
  originElement?: HTMLElement | null;
};

type Props = {
  state: MessageContextMenuState;
  metadataPrecision?: 'second' | 'millisecond';
  metadataSequence?: string;
  onClose?: () => void;
  onCopy: (message: Message) => void | Promise<void>;
  onForward?: (message: Message) => void;
  forwardBlockedReason?: string | null;
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
  onReact?: (message: Message, returnFocusTo: HTMLElement | null) => void;
  showReactions?: boolean;
  onSetReaction?: (message: Message, code: string, isSet: boolean) => void;
  reactBlockedReason?: string | null;
  reactions?: readonly ReactionItem[];
  essenceAction?: ReactNode;
  todoAction?: ReactNode;
  intentAction?: ReactNode;
  translationAction?: ReactNode;
  favoriteEmojiAction?: ReactNode;
  revealAction?: ReactNode;
  forwardVoice?: import('../../hooks/useVoiceTranscription').VoiceTranscriptionInput['forward'];
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

function messageCardElements(state: MessageContextMenuState) {
  const elements = state.message.qqElements ?? [];
  const forwarded = state.forwardTarget && elements[state.forwardTarget.elementIndex];
  if (forwarded) return [forwarded];
  const structured = elements.find((element) =>
    ['ark', 'wallet', 'qqDynamic', 'shareLocation', 'multiMsg', 'structLongMsg'].includes(
      element.type ?? '',
    ),
  );
  if (structured) return [structured];
  const flash = elements.find((element) => {
    const info = element.data?.flashTransferInfo;
    return (
      (element.type === 'markdown' &&
        info &&
        typeof info === 'object' &&
        Object.keys(info).length) ||
      (element.type === 'text' && parseFlashShareCode(String(element.data?.textContent ?? '')))
    );
  });
  if (flash) return [flash];
  if (elements.some((element) => element.type === 'inlineKeyboard'))
    return elements.filter(
      ({ type }) => type === 'inlineKeyboard' || type === 'markdown' || type === 'mface',
    );
  if (state.originElement?.querySelector('.weq-link-card'))
    return elements.filter(({ type }) => type === 'text');
  const media = state.mediaTarget;
  const attachment =
    media?.kind === 'file'
      ? elements.find(
          ({ type, data }) =>
            type === 'file' &&
            String(data?.fileName ?? '') === media.name &&
            String(data?.fileToken ?? '') === media.token,
        )
      : elements.find(({ type }) => type === 'onlineFile' || type === 'onlineFolder');
  return attachment ? [attachment] : [];
}

function cardJson(elements: ReturnType<typeof messageCardElements>): string {
  const element = elements[0];
  const ark = element?.type === 'ark' ? element.data?.arkData : null;
  if (typeof ark === 'string') {
    try {
      JSON.parse(ark);
      return ark;
    } catch {
      // 不是有效 JSON 的旧卡片用原元素包裹，保留原始值。
    }
  }
  return JSON.stringify(
    ark && typeof ark === 'object' ? ark : elements.length === 1 ? element : elements,
    null,
    2,
  );
}

export function MessageContextMenu(props: Props) {
  const { state, onClose, onCopy, reactions = DEFAULT_REACTIONS } = props;
  const document = useRenderDocument();
  const toast = useToastApi();
  const window = document.defaultView ?? globalThis.window;
  const tabActive = useTabActive();
  const { layer, scope } = useOverlayLayerScope(tabActive);
  const message = state.message;
  const metadataId = useId();
  const time = props.metadataPrecision
    ? formatDateTime(message.createdAt, props.metadataPrecision)
    : '';
  const seq = props.metadataPrecision
    ? messageSequence(props.metadataSequence ?? message.msgSeq)
    : null;
  const roaming = Boolean(props.metadataPrecision && showsRoamingSource(message));
  const hasMetadata = Boolean(time || seq || roaming);
  const originElement = state.originElement;
  const { panel: menuRef } = useTabPanelMotion(JSON.stringify([message.id, state.x, state.y]));
  useSurfaceRemovalFade(menuRef, { enabled: tabActive });
  const focusedIndex = useRef(0);
  const restoreFocus = useRef(true);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const [feedbackHost, setFeedbackHost] = useState<HTMLDivElement | null>(null);
  const [reactionCapacity, setReactionCapacity] = useState(0);
  const showReactions = (props.showReactions ?? true) && Boolean(props.onReact);
  useSurfaceOutside(menuRef, onClose, tabActive, { secondaryPress: true });

  const buttons = useCallback(
    () =>
      [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
        (button) => getComputedStyle(button).display !== 'none',
      ),
    [menuRef],
  );

  useEffect(() => {
    if (!tabActive) return;
    restoreFocus.current = true;
    const menu = menuRef.current;
    const previous = document.activeElement;
    // 右键按下也可能让消息行获得焦点。只恢复打开菜单前已显示的焦点。
    const previousFocus =
      previous instanceof window.HTMLElement &&
      previous.matches(':focus-visible') &&
      !menu?.contains(previous)
        ? previous
        : null;
    returnFocusTo.current = previousFocus;
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
          previousFocus?.isConnected
        )
          previousFocus.focus({ preventScroll: true });
      });
    };
  }, [message.id, originElement, buttons, document, window, tabActive, menuRef]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!tabActive || !el) return;
    const place = () => {
      const rect = el.getBoundingClientRect();
      const strip = el.querySelector<HTMLElement>('.message-reaction-strip');
      const capacity = quickReactionCapacity(strip?.getBoundingClientRect().width ?? 0);
      const focused = [
        ...(strip?.querySelectorAll('button[role="menuitemcheckbox"]') ?? []),
      ].indexOf(el.ownerDocument.activeElement as HTMLButtonElement);
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
  }, [state.x, state.y, state.variant, showReactions, window, tabActive, menuRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      restoreFocus.current = false;
      let next = returnFocusTo.current;
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
        const origin = state.originElement;
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
          data-danger={item.danger ? 'outline' : undefined}
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
  const cards = messageCardElements(state);
  const copyCard = cards.length
    ? async () => {
        try {
          const copied = copyTextToClipboard(cardJson(cards), document);
          onClose?.();
          if (await copied) {
            toast.push({ tone: 'success', title: '已复制 JSON' });
            return;
          }
        } catch {
          // 与剪贴板写入失败使用同一反馈。
        }
        toast.push({ tone: 'error', title: '复制失败', detail: '无法复制卡片 JSON，请重试。' });
      }
    : undefined;

  const content = (
    <MessageMenuContext.Provider value={true}>
      <MessageMenuFeedbackContext.Provider value={feedbackHost}>
        <div
          ref={menuRef}
          hidden={!tabActive}
          data-weq-surface-motion="enter"
          role="menu"
          aria-label="消息操作"
          aria-describedby={hasMetadata ? metadataId : undefined}
          data-hover-delay="0"
          className={cn(
            'message-context-menu',
            'message-menu-v2',
            state.variant === 'mobile' && 'message-menu-touch',
          )}
          style={{ left: state.x, top: state.y, zIndex: layer }}
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
                  onClick={() => props.onReact?.(message, returnFocusTo.current)}
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
                action('copy-card-json', '复制 JSON', <Braces {...icon} />, copyCard),
                action(
                  'reply',
                  '引用',
                  <Reply {...icon} />,
                  call(props.onReply),
                  props.replyBlockedReason,
                ),
                action(
                  'forward',
                  '转发',
                  <Forward {...icon} />,
                  call(props.onForward),
                  props.forwardBlockedReason,
                  Boolean(props.onForward) && forwardContentBlockReason(message) === null,
                ),
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
                  <VoiceTranscribeMenuAction
                    message={message}
                    target={media}
                    onClose={onClose}
                    forward={props.forwardVoice}
                  />
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
                        '另存为',
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
              <div className="message-menu-slot">{props.translationAction}</div>
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
          {hasMetadata ? (
            <p className="message-menu-metadata" id={metadataId} aria-hidden="true">
              {time ? (
                <span>
                  <NumericText>{time}</NumericText>（北京时间）
                </span>
              ) : null}
              {seq ? (
                <span>
                  seq <NumericText>{seq}</NumericText>
                </span>
              ) : null}
              {roaming ? (
                <span>{message.sourceFormat === 'native' ? 'QQ 原生漫游' : 'WeQ 漫游缓存'}</span>
              ) : null}
            </p>
          ) : null}
          <div className="message-menu-feedback" ref={setFeedbackHost} />
        </div>
      </MessageMenuFeedbackContext.Provider>
    </MessageMenuContext.Provider>
  );
  return (
    <OverlayLayerContext.Provider value={scope}>
      {createPortal(content, document.body)}
    </OverlayLayerContext.Provider>
  );
}
