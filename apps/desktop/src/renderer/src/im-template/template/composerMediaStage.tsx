// @ts-nocheck
/**
 * 待发送文件 / 视频托盘、超级表情卡片、拖拽落点与预览灯箱。
 * 图片不走这里 —— 图片像表情一样内联进输入框（见 chatPane 的 insertInlineImage）。
 */

import { useState } from 'react';
import { useTabActive } from '../../components/RetainedTabs';
import { FolderOpen, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { MediaPreview } from '../../components/MediaPreview';
import { cn } from './classNames';
import {
  attachmentKindText,
  attachmentMetaText,
  formatClipDuration,
  type ComposerAttachment,
} from './composerMedia';
import type { EmojiItem } from './emojiPacks';
import '../styles/composer-media-tray.css';

export function ComposerMediaStage({
  attachments,
  onRemove,
  panelRef,
}: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className={cn('composer-media-tray')}
      ref={panelRef}
      aria-label={`待发送附件 ${attachments.length} 项`}
    >
      {attachments.map((attachment) => (
        <ComposerMediaItem
          key={attachment.id}
          attachment={attachment}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  );
}

function ComposerMediaItem({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const tabActive = useTabActive();
  const kindLabel = attachmentKindText(attachment.kind);
  const playable = attachment.kind === 'video' && Boolean(attachment.url);

  return (
    <>
      <ComposerSingleCard
        kind={attachment.kind}
        name={attachment.name}
        meta={attachmentMetaText(attachment)}
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
        <MediaPreview
          active={tabActive}
          onClose={() => setPreview(false)}
          items={[
            { key: attachment.id, kind: 'video', src: attachment.url, title: attachment.name },
          ]}
          renderActions={() => <span>{attachmentMetaText(attachment)}</span>}
        />
      ) : null}
    </>
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
  note?: string;
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
        {note ? <span className={cn('composer-single-note')}>{note}</span> : null}
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
        <span>图片、视频和文件</span>
      </div>
    </div>
  );
}

/** 从剪贴板 / 拖拽里挑出可用的文件。 */
export function collectFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.size >= 0);
}
