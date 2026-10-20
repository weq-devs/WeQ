import {
  Copy,
  Download,
  FolderOpen,
  Clock,
  RotateCcw,
  Trash2,
  Edit3,
  ListChecks,
  Palette,
  Quote,
  SmilePlus,
  Forward,
  ListPlus,
  Repeat2,
} from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Message } from './types';
import { cn } from './classNames';
import { FaceEmoji } from '../../components/FaceEmoji';
import { canRepeatMessage } from '../../lib/messageRepeat';
import { useSurfaceOutside } from '../../lib/surfaceOutside';
import { useTabActive } from '../../components/RetainedTabs';
import { IS_WEB } from '../../lib/target';
import type { ExportSavePolicy } from '@weq/service';

export type MessageContextMenuState = {
  message: Message;
  x: number;
  y: number;
  downloadUrl?: string;
  imageUrl?: string;
  variant?: 'desktop' | 'mobile';
  /**
   * Click point offset within the anchored message row at open time. Used to
   * keep the desktop menu glued to its message while the list scrolls.
   */
  anchorOffsetX?: number;
  anchorOffsetY?: number;
};

export function MessageContextMenu({
  state,
  onClose,
  onCopy,
  onExport,
  exportLabel = '导出',
  exportBlockedReason,
  onForward,
  onRepeat,
  repeatBlockedReason,
  onAddToComposition,
  onDownloadImage,
  downloadDisabled = false,
  onDelete,
  deleteLabel = '删除',
  onEditRaw,
  onViewDecoration,
  onReply,
  replyBlockedReason,
  onMultiSelect,
  onReact,
  reactBlockedReason,
  onRecall,
  recallBlockedReason,
  onRemoveReaction,
  removeReactionBlockedReason,
  extraActions,
}: {
  state: MessageContextMenuState;
  onClose?: () => void;
  onCopy: (message: Message) => void | Promise<void>;
  onExport?: (message: Message) => void;
  exportLabel?: string;
  exportBlockedReason?: string;
  onForward?: (message: Message) => void;
  onRepeat?: (message: Message) => void;
  repeatBlockedReason?: string | null;
  onAddToComposition?: (message: Message) => void;
  onDownloadImage?: (
    url: string,
    message: Message,
    intent?: ExportSavePolicy,
    browser?: boolean,
  ) => void;
  downloadDisabled?: boolean;
  /** 原库消息保留可恢复遮罩；失败占位仅从本机移除，由宿主区分两条路径。 */
  onDelete?: (message: Message) => void;
  deleteLabel?: string;
  onEditRaw?: (message: Message) => void;
  onViewDecoration?: (message: Message) => void;
  /** 引用：把这条消息挂到输入框上方（引用条）。 */
  onReply?: (message: Message) => void;
  /** 非空 = 这条消息不能引用（系统消息 / 缺少会话内序号…），按钮置灰并显示原因。 */
  replyBlockedReason?: string | null;
  /** 进入多选：把这条消息加入选择集并切到多选模式。 */
  onMultiSelect?: (message: Message) => void;
  /** 贴表情：打开表情面板给这条群消息贴一个回应。 */
  onReact?: (message: Message) => void;
  /** 非空 = 这条消息不能贴表情（非群聊 / QQ 未在线 / 缺 seq），按钮置灰并显示原因。 */
  reactBlockedReason?: string | null;
  /**
   * 撤回（SsoC2CRecallMsg / SsoGroupRecallMsg）。不传 = 这条消息不显示撤回项
   * （不是自己的消息，且自己在群里也没有管理员权限）。
   */
  onRecall?: (message: Message) => void;
  /** 非空 = 撤回按钮置灰（QQ 未在线 / 超过 2 分钟且无越级权限 / 缺 seq）。 */
  recallBlockedReason?: string | null;
  onRemoveReaction?: (message: Message, code: string) => void;
  removeReactionBlockedReason?: string | null;
  extraActions?: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const active = useTabActive();
  useSurfaceOutside(menuRef, onClose, active);
  const decoration = (
    state.message as { decoration?: { fontId?: number; bubbleId?: number; widgetId?: number } }
  ).decoration;
  const hasDecoration =
    decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId);

  // 菜单是 fixed 定位，但打开时和滚动跟随只按估算尺寸钳制；这里用渲染后的
  // 实际尺寸把菜单拉回窗口内，避免靠近窗口边缘（尤其底部）时被截断。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    if (state.variant === 'mobile') {
      const halfWidth = rect.width / 2;
      el.style.left = `${Math.min(
        Math.max(state.x, halfWidth + margin),
        Math.max(halfWidth + margin, window.innerWidth - halfWidth - margin),
      )}px`;
    } else {
      el.style.left = `${Math.min(
        Math.max(state.x, margin),
        Math.max(margin, window.innerWidth - rect.width - margin),
      )}px`;
    }
    el.style.top = `${Math.min(
      Math.max(state.y, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    )}px`;
  }, [state.x, state.y, state.variant]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className={cn(
        'message-context-menu',
        state.variant === 'mobile' && 'message-context-menu-mobile',
        state.downloadUrl && 'message-context-menu-has-download',
      )}
      style={
        state.variant === 'mobile'
          ? { left: state.x, top: state.y, transform: 'translateX(-50%)' }
          : { left: state.x, top: state.y }
      }
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      {extraActions}
      {onMultiSelect ? (
        <button type="button" title="多选" onClick={() => onMultiSelect(state.message)}>
          <ListChecks size={17} />
          <span>多选</span>
        </button>
      ) : null}
      {onExport ? (
        <button
          type="button"
          title={exportBlockedReason ?? exportLabel}
          disabled={Boolean(exportBlockedReason)}
          onClick={() => onExport(state.message)}
        >
          <Download size={17} />
          <span>{exportLabel}</span>
        </button>
      ) : null}
      {onAddToComposition ? (
        <button
          type="button"
          title="添加到素材库"
          onClick={() => onAddToComposition(state.message)}
        >
          <ListPlus size={17} />
          <span>添加到素材库</span>
        </button>
      ) : null}
      {onForward ? (
        <button type="button" title="转发" onClick={() => onForward(state.message)}>
          <Forward size={17} />
          <span>转发</span>
        </button>
      ) : null}
      {onRepeat && canRepeatMessage(state.message) ? (
        <button
          type="button"
          title={repeatBlockedReason || '发送一条相同的消息'}
          disabled={Boolean(repeatBlockedReason)}
          onClick={() => onRepeat(state.message)}
        >
          <Repeat2 size={17} />
          <span>+1</span>
        </button>
      ) : null}
      {onReply ? (
        <button
          type="button"
          title={replyBlockedReason ?? '引用这条消息'}
          disabled={Boolean(replyBlockedReason)}
          onClick={() => onReply(state.message)}
        >
          <Quote size={17} />
          <span>引用</span>
        </button>
      ) : null}
      {onReact ? (
        <button
          type="button"
          title={reactBlockedReason ?? '给这条消息贴一个表情'}
          disabled={Boolean(reactBlockedReason)}
          onClick={() => onReact(state.message)}
        >
          <SmilePlus size={17} />
          <span>贴表情</span>
        </button>
      ) : null}
      {onRecall ? (
        <button
          type="button"
          title={recallBlockedReason ?? '撤回这条消息'}
          disabled={Boolean(recallBlockedReason)}
          onClick={() => onRecall(state.message)}
        >
          <RotateCcw size={17} />
          <span>撤回</span>
        </button>
      ) : null}
      {onRemoveReaction
        ? state.message.setEmojiList
            ?.filter((item) => item.isSelfSet)
            .map((item) => (
              <button
                type="button"
                key={`remove-${item.emojiId}`}
                aria-label={`撤回贴表情 ${item.emojiId}`}
                title={removeReactionBlockedReason || `撤回自己的贴表情 ${item.emojiId}`}
                disabled={Boolean(removeReactionBlockedReason)}
                onClick={() => onRemoveReaction(state.message, item.emojiId)}
              >
                <FaceEmoji element={{ faceId: Number(item.emojiId) }} size={17} />
                <span>撤回贴表情</span>
              </button>
            ))
        : null}
      <button type="button" onClick={() => void onCopy(state.message)}>
        <Copy size={17} />
        <span>复制</span>
      </button>
      {onEditRaw ? (
        <button type="button" onClick={() => onEditRaw(state.message)}>
          <Edit3 size={17} />
          <span>修改本地记录</span>
        </button>
      ) : null}
      {hasDecoration && onViewDecoration ? (
        <button type="button" onClick={() => onViewDecoration(state.message)}>
          <Palette size={17} />
          <span>装扮</span>
        </button>
      ) : null}
      {state.downloadUrl && onDownloadImage ? (
        <>
          <button
            type="button"
            disabled={downloadDisabled}
            onClick={() => onDownloadImage(state.downloadUrl ?? '', state.message)}
          >
            <Download size={17} />
            <span>{IS_WEB ? '保存到服务器' : '下载'}</span>
          </button>
          <button
            type="button"
            disabled={downloadDisabled}
            onClick={() =>
              onDownloadImage(state.downloadUrl ?? '', state.message, { mode: 'before' })
            }
          >
            <FolderOpen size={17} />
            <span>{IS_WEB ? '另存到服务器…' : '另存到…'}</span>
          </button>
          <button
            type="button"
            disabled={downloadDisabled}
            onClick={() =>
              onDownloadImage(state.downloadUrl ?? '', state.message, { mode: 'after' })
            }
          >
            <Clock size={17} />
            <span>先生成，稍后保存</span>
          </button>
          {IS_WEB && (
            <button
              type="button"
              disabled={downloadDisabled}
              onClick={() =>
                onDownloadImage(state.downloadUrl ?? '', state.message, undefined, true)
              }
            >
              <Download size={17} />
              <span>下载到浏览器</span>
            </button>
          )}
        </>
      ) : null}
      {onDelete ? (
        <button type="button" aria-label={deleteLabel} onClick={() => onDelete(state.message)}>
          <Trash2 size={17} />
          <span>{deleteLabel}</span>
        </button>
      ) : null}
    </div>
  );
}
