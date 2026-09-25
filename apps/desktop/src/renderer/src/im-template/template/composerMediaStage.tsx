// @ts-nocheck
/**
 * 输入框里的「视频 / 文件」卡片（媒体舞台）、拖拽落点提示与预览灯箱。
 *
 * 视频和文件只能**单独**发，所以它们不再排成托盘挂在输入框上面，而是直接占掉
 * 正文编辑区那一行：左侧缩略图（视频可点开灯箱）、右侧文件名 + 元信息、右上角叉号。
 * 这一行出现时正文编辑区被隐藏，发送键只发这一个附件，不带走文字。
 *
 * 图片不走这里 —— 图片像表情一样内联进输入框（见 chatPane 的 insertInlineImage）。
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import {
  attachmentKindText,
  attachmentMetaText,
  formatClipDuration,
  type ComposerAttachment,
} from './composerMedia';

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

  return (
    <div
      className={cn('composer-media-stage', `is-${attachment.kind}`)}
      ref={panelRef}
      aria-label="待发送的视频或文件"
    >
      <div className={cn('composer-media-card')} title={attachment.name}>
        <button
          type="button"
          className={cn('composer-media-thumb')}
          onClick={attachment.kind === 'video' && attachment.url ? () => setPreview(true) : undefined}
          aria-label={attachment.kind === 'video' ? `预览${kindLabel} ${attachment.name}` : kindLabel}
        >
          {attachment.kind === 'video' && attachment.url ? (
            <>
              <video src={attachment.url} muted preload="metadata" />
              <span className={cn('composer-media-play')} aria-hidden="true" />
              {attachment.duration ? (
                <span className={cn('composer-media-duration')}>
                  {formatClipDuration(attachment.duration * 1000)}
                </span>
              ) : null}
            </>
          ) : (
            <span className={cn('composer-media-file')}>
              <FolderOpen size={20} strokeWidth={1.7} />
            </span>
          )}
        </button>
        <span className={cn('composer-media-info')}>
          <strong title={attachment.name}>{attachment.name}</strong>
          <em>{attachmentMetaText(attachment)}</em>
          <span className={cn('composer-media-note')}>
            {kindLabel}只能单独发送，不会带上输入框里的文字
          </span>
        </span>
        <button
          type="button"
          className={cn('composer-media-remove')}
          title="移除"
          aria-label={`移除 ${attachment.name}`}
          onClick={onRemove}
        >
          <X size={13} strokeWidth={2.6} />
        </button>
      </div>
      {preview && attachment.url ? (
        <AttachmentLightbox attachment={attachment} onClose={() => setPreview(false)} />
      ) : null}
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
