/**
 * 消息装扮预览卡片（屏幕正中间弹出）。
 *
 * 右键消息气泡时显示该消息的三装扮（字体/气泡/挂件）的 ID 和预览图。
 */
import { Palette, X, ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "../im-template/template/modalUtils";

interface MessageDecorationCardProps {
  decoration: {
    fontId: number;
    bubbleId: number;
    widgetId: number;
  } | null;
  onClose: () => void;
}

function getPreviewUrl(type: 'font' | 'bubble' | 'widget', id: number): string {
  if (type === 'font') {
    return `https://tianquan.gtimg.cn/font/item/${id}/newPreview1.png`;
  }
  if (type === 'bubble') {
    return `https://tianquan.gtimg.cn/bubble/item/${id}/newPreview1.png`;
  }
  return `https://tianquan.gtimg.cn/faceAddon/item/${id}/newPreview1.png`;
}

function getLocalUrl(type: 'font' | 'bubble' | 'widget', id: number): string {
  const isWeb = import.meta.env.VITE_WEQ_TARGET === 'web';

  if (type === 'font') {
    return isWeb ? `/_asset/dress/fonts/${id}.ttf` : `weq-asset://dress/fonts/${id}.ttf`;
  }
  if (type === 'bubble') {
    return isWeb ? `/_media/dressbubble?id=${id}` : `weq-media://dressbubble?id=${id}`;
  }
  return isWeb ? `/_media/dresspendant?id=${id}&frame=1` : `weq-media://dresspendant?id=${id}&frame=1`;
}

interface DecorationItemProps {
  type: 'font' | 'bubble' | 'widget';
  id: number;
  label: string;
  icon: React.ReactNode;
}

function DecorationItem({ type, id, label, icon }: DecorationItemProps) {
  const [imageState, setImageState] = useState<'cdn' | 'local' | 'fallback'>('cdn');
  const cdnUrl = getPreviewUrl(type, id);
  const localUrl = getLocalUrl(type, id);

  return (
    <div className="weq-decoration-card-item">
      <div className="weq-decoration-card-header">
        <span className="weq-decoration-card-icon">{icon}</span>
        <div className="weq-decoration-card-info">
          <span className="weq-decoration-card-label">{label}</span>
          <span className="weq-decoration-card-id">ID: {id}</span>
        </div>
      </div>
      <div className="weq-decoration-card-preview">
        {imageState === 'fallback' ? (
          <div className="weq-decoration-card-empty">
            <ImageOff size={32} strokeWidth={1.5} />
            <span>暂无预览</span>
          </div>
        ) : (
          <img
            src={imageState === 'cdn' ? cdnUrl : localUrl}
            alt={`${label}预览`}
            onError={() => {
              if (imageState === 'cdn') {
                setImageState('local');
              } else {
                setImageState('fallback');
              }
            }}
            onLoad={() => {
              // 图片成功加载
            }}
          />
        )}
      </div>
    </div>
  );
}

export function MessageDecorationCard({ decoration, onClose }: MessageDecorationCardProps) {
  const cardRef = useRef<HTMLElement>(null);

  useEscapeToClose(onClose);

  const hasDecoration = decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId);
  const items = [];

  if (decoration?.fontId) {
    items.push({ type: 'font' as const, id: decoration.fontId, label: '字体', icon: '🖋️' });
  }
  if (decoration?.bubbleId) {
    items.push({ type: 'bubble' as const, id: decoration.bubbleId, label: '气泡', icon: '💬' });
  }
  if (decoration?.widgetId) {
    items.push({ type: 'widget' as const, id: decoration.widgetId, label: '挂件', icon: '✨' });
  }

  return createPortal(
    <div
      className="weq-profile-layer"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={cardRef}
        className="weq-profile-dialog weq-decoration-card weq-anim-pop"
        style={{
          maxWidth: "800px",
          width: "90%",
        }}
        role="dialog"
        aria-modal="true"
        aria-label="消息装扮"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-profile-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} />
        </button>

        <div className="weq-decoration-card-title">
          <Palette size={20} strokeWidth={2} />
          <span>消息装扮</span>
        </div>

        {!hasDecoration ? (
          <div className="weq-decoration-card-empty-state">
            <Palette size={48} strokeWidth={1.5} opacity={0.3} />
            <span>此消息未使用装扮</span>
          </div>
        ) : (
          <div className="weq-decoration-card-grid">
            {items.map((item) => (
              <DecorationItem
                key={item.type}
                type={item.type}
                id={item.id}
                label={item.label}
                icon={item.icon}
              />
            ))}
          </div>
        )}
      </section>
    </div>,
    document.body
  );
}
