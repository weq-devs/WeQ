/**
 * 消息装扮预览卡片（屏幕正中间弹出）。
 *
 * 右键消息气泡时显示该消息的三装扮（字体/气泡/挂件）的 ID 和预览图。
 */
import { Palette, X, ImageOff, Type, MessageCircle, Sparkles } from "lucide-react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "../im-template/template/modalUtils";
import { trpc } from "../trpc/client";
import { dressFontUrl } from "../lib/resourceUrl";

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

  if (type === 'bubble') {
    return isWeb ? `/_media/dressbubble?id=${id}` : `weq-media://dressbubble?id=${id}`;
  }
  return isWeb ? `/_media/dresspendant?id=${id}&frame=1` : `weq-media://dresspendant?id=${id}&frame=1`;
}

type ImageState = 'cdn' | 'local' | 'font' | 'fallback';
type FontPreviewState = 'loading' | 'ready' | 'unavailable';

interface DecorationItemProps {
  type: 'font' | 'bubble' | 'widget';
  id: number;
  label: string;
  icon: React.ReactNode;
}

function DecorationItem({ type, id, label, icon }: DecorationItemProps) {
  const [imageState, setImageState] = useState<ImageState>('cdn');
  const [fontPreviewState, setFontPreviewState] = useState<FontPreviewState>('loading');
  const cdnUrl = getPreviewUrl(type, id);
  const localUrl = type === 'font' ? '' : getLocalUrl(type, id);
  const fontFamily = `weq-message-decoration-${id}`;
  const fontResource = trpc.account.dressup.resolveMsgDecoration.useQuery(
    { bubbleId: 0, fontId: type === 'font' ? id : 0, widgetId: 0 },
    {
      enabled: type === 'font' && imageState === 'font',
      staleTime: Infinity,
    },
  );

  useEffect(() => {
    if (type !== 'font' || imageState !== 'font') return;
    if (fontResource.isInitialLoading) {
      setFontPreviewState('loading');
      return;
    }
    if (!fontResource.data?.fontFile) {
      setFontPreviewState('unavailable');
      return;
    }

    let cancelled = false;
    setFontPreviewState('loading');
    void new FontFace(fontFamily, `url("${dressFontUrl(id)}")`)
      .load()
      .then((face) => {
        if (cancelled) return;
        document.fonts.add(face);
        setFontPreviewState('ready');
      })
      .catch(() => {
        if (!cancelled) setFontPreviewState('unavailable');
      });

    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontResource.data?.fontFile, fontResource.isInitialLoading, id, imageState, type]);

  const showFontPreview = type === 'font' && imageState === 'font' && fontPreviewState === 'ready';

  function renderFontPreview() {
    if (showFontPreview) {
      return (
        <div className="weq-decoration-card-font-preview" style={{ fontFamily: `"${fontFamily}"` }}>
          <span className="is-symbol">!@#$%^&amp;*()[]{}+-=</span>
          <span className="is-english">Aa Bb Cc Xx Yy Zz</span>
          <span className="is-number">0123456789</span>
          <span className="is-chinese">中文（WeQ装扮管理器）</span>
        </div>
      );
    }
    if (fontPreviewState === 'loading') {
      return (
        <div className="weq-decoration-card-empty">
          <Loader2 size={26} strokeWidth={1.5} className="weq-decoration-card-spin" />
          <span>正在加载字体</span>
        </div>
      );
    }
    return (
      <div className="weq-decoration-card-empty">
        <ImageOff size={32} strokeWidth={1.5} />
        <span>暂无预览</span>
      </div>
    );
  }

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
        {imageState === 'font' ? (
          renderFontPreview()
        ) : imageState === 'fallback' ? (
          <div className="weq-decoration-card-empty">
            <ImageOff size={32} strokeWidth={1.5} />
            <span>暂无预览</span>
          </div>
        ) : (
          <img
            src={imageState === 'cdn' ? cdnUrl : localUrl}
            alt={`${label}预览`}
            onError={() => {
              if (type === 'font') {
                setImageState('font');
              } else if (imageState === 'cdn') {
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
    items.push({ type: 'font' as const, id: decoration.fontId, label: '字体', icon: <Type size={18} /> });
  }
  if (decoration?.bubbleId) {
    items.push({ type: 'bubble' as const, id: decoration.bubbleId, label: '气泡', icon: <MessageCircle size={18} /> });
  }
  if (decoration?.widgetId) {
    items.push({ type: 'widget' as const, id: decoration.widgetId, label: '挂件', icon: <Sparkles size={18} /> });
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
