// @ts-nocheck
/**
 * 输入框里的「只能单独发」卡片（媒体舞台 / 超级表情）、拖拽落点提示与预览灯箱。
 *
 * 视频、文件和超级表情都只能**单独**发，所以它们不排成托盘挂在输入框上面，而是直接
 * 占掉正文编辑区那一行：一张居中的大卡片 —— 大图标 / 缩略图在上，名称与元信息在下，
 * 右上角叉号。这一行出现时正文编辑区被隐藏，发送键只发这一个，不带走文字。
 *
 * 图片不走这里 —— 图片像表情一样内联进输入框（见 chatPane 的 insertInlineImage）。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import {
  attachmentKindText,
  attachmentMetaText,
  formatClipDuration,
  type ComposerAttachment,
} from './composerMedia';
import type { EmojiItem } from './emojiPacks';

export function ComposerMediaStage({
  attachment,
  onRemove,
  panelRef,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const [preview, setPreview] = useState(false);
  const kindLabel = attachmentKindText(attachment.kind);
  const playable = attachment.kind === 'video' && Boolean(attachment.url);

  return (
    <div className={cn('composer-single-stage')} ref={panelRef} aria-label="待发送的视频或文件">
      <ComposerSingleCard
        kind={attachment.kind}
        name={attachment.name}
        meta={attachmentMetaText(attachment)}
        note={`${kindLabel}只能单独发送，不会带上输入框里的文字`}
        thumbTitle={playable ? `预览${kindLabel} ${attachment.name}` : kindLabel}
        onThumbClick={playable ? () => setPreview(true) : undefined}
        onRemove={onRemove}
        thumb={
          playable ? (
            <>
              <video src={attachment.url ?? undefined} muted preload="metadata" />
              <span className={cn('composer-single-play')} aria-hidden="true" />
              {attachment.duration ? (
                <span className={cn('composer-single-duration')}>
                  {formatClipDuration(attachment.duration * 1000)}
                </span>
              ) : null}
            </>
          ) : (
            <FolderOpen size={46} strokeWidth={1.4} />
          )
        }
      />
      {preview && attachment.url ? (
        <AttachmentLightbox attachment={attachment} onClose={() => setPreview(false)} />
      ) : null}
    </div>
  );
}

/**
 * 超级表情卡片。形态和视频 / 文件一致（它也只能单独发）：大图在上、名称与说明在下。
 * 这里显示的是**小号**的那张静态图 —— 大号 lottie 只在消息气泡里播（表情包在输入框
 * 里不播动画，避免一挂卡片就烧掉一份 lottie）。
 */
export function ComposerSuperEmojiStage({
  item,
  onRemove,
  panelRef,
}: {
  item: EmojiItem;
  onRemove: () => void;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className={cn('composer-single-stage')} ref={panelRef} aria-label="待发送的超级表情">
      <ComposerSingleCard
        kind="super-emoji"
        name={item.name}
        meta="超级表情"
        note="超级表情只能单独发送，不会带上输入框里的文字"
        thumbTitle={item.name}
        onRemove={onRemove}
        thumb={
          item.src ? (
            <img src={item.src} alt={item.name} draggable={false} />
          ) : (
            <span className={cn('composer-single-glyph')}>{item.glyph || item.name}</span>
          )
        }
      />
    </div>
  );
}

/**
 * 「只能单独发」的卡片本体：居中大图标 / 缩略图在上，名称 + 元信息 + 说明在下，
 * 右上角移除。视频 / 文件和超级表情共用这一张。
 */
function ComposerSingleCard({
  kind,
  thumb,
  name,
  meta,
  note,
  thumbTitle,
  onThumbClick,
  onRemove,
}: {
  kind: string;
  thumb: ReactNode;
  name: string;
  meta: string;
  note: string;
  thumbTitle: string;
  /** 缩略图可点开灯箱时给（目前只有视频）；文件类图标不可点。 */
  onThumbClick?: () => void;
  onRemove: () => void;
}) {
  const thumbClass = cn('composer-single-thumb');
  return (
    <div className={cn('composer-single-card', `is-${kind}`)} title={name}>
      {onThumbClick ? (
        <button type="button" className={thumbClass} aria-label={thumbTitle} onClick={onThumbClick}>
          {thumb}
        </button>
      ) : (
        <span className={thumbClass} aria-hidden="true">
          {thumb}
        </span>
      )}
      <div className={cn('composer-single-info')}>
        <strong title={name}>{name}</strong>
        <em>{meta}</em>
        <span className={cn('composer-single-note')}>{note}</span>
      </div>
      <button
        type="button"
        className={cn('composer-single-remove')}
        title="移除"
        aria-label={`移除 ${name}`}
        onClick={onRemove}
      >
        <X size={14} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: ComposerAttachment;
  onClose: () => void;
}) {
  const layer = useOverlayLayer(true);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className={cn('composer-media-lb-layer')} style={{ zIndex: layer }} onMouseDown={onClose}>
      <div className={cn('composer-media-lb')} onMouseDown={(event) => event.stopPropagation()}>
        <header className={cn('composer-media-lb-head')}>
          <span className={cn('composer-media-lb-title')}>
            {attachment.kind === 'video' ? <FolderOpen size={15} /> : null}
            {attachment.name}
          </span>
          <em>{attachmentMetaText(attachment)}</em>
          <button
            type="button"
            className={cn('composer-media-lb-close')}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>
        <div className={cn('composer-media-lb-body')}>
          {attachment.url ? <video src={attachment.url} controls autoPlay /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 拖拽落点提示：整块输入区变成「松手即添加」的落点。
 *
 * `visible` 只在拖进来的确实是文件（dataTransfer 里带 Files）时才亮，避免拖一段
 * 文本进来也闪一片蓝。
 */
export function ComposerDropVeil({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className={cn('composer-drop-veil')} aria-hidden="true">
      <div className={cn('composer-drop-veil-inner')}>
        <FolderOpen size={26} strokeWidth={1.6} />
        <strong>松开即可添加</strong>
        <span>图片会插进输入框；视频 / 文件单独发送</span>
      </div>
    </div>
  );
}

/** 从剪贴板 / 拖拽里挑出可用的文件。 */
export function collectFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.size >= 0);
}
