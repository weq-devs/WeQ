/**
 * 消息装扮预览卡片（屏幕正中间弹出）。
 *
 * 右键消息气泡时显示该消息的三装扮（字体/气泡/挂件）的 ID 和预览图。
 */
import { Download, Palette, X, ImageOff, Type, MessageCircle, Sparkles } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { OverlayLayer } from './OverlayLayer';
import { trpc } from '../trpc/client';
import { dressFontUrl } from '../lib/resourceUrl';
import { useToast } from './Toast';

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
  return isWeb
    ? `/_media/dresspendant?id=${id}&frame=1`
    : `weq-media://dresspendant?id=${id}&frame=1`;
}

type ImageState = 'cdn' | 'local' | 'font' | 'fallback';
type FontPreviewState = 'loading' | 'ready' | 'unavailable';
type DecorationKind = 'font' | 'bubble' | 'widget';

interface DecorationItemProps {
  type: 'font' | 'bubble' | 'widget';
  id: number;
  label: string;
  icon: React.ReactNode;
}

type DecorationItemRow = DecorationItemProps & { type: DecorationKind };

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
    // 字体要「解析出来了」才能试加载（路径在主进程，渲染只知道自己拼的 url）。
    const derived = fontResource.data?.font;
    if (!derived) {
      setFontPreviewState('unavailable');
      return;
    }

    let cancelled = false;
    setFontPreviewState('loading');
    // 带派生版本：升级后同一款字体的产物被就地重做，url 跟着变才能绕过浏览器缓存。
    void new FontFace(fontFamily, `url("${dressFontUrl(id, derived.deriveVersion)}")`)
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
  }, [fontFamily, fontResource.data?.font, fontResource.isInitialLoading, id, imageState, type]);

  const showFontPreview = type === 'font' && imageState === 'font' && fontPreviewState === 'ready';

  function renderFontPreview() {
    if (showFontPreview) {
      return (
        <div className="weq-decoration-card-font-preview" style={{ fontFamily: `"${fontFamily}"` }}>
          <span className="is-symbol">0123456789!@#$%^&amp;*()[]{}+-=</span>
          <span className="is-symbol">abcdefghijklmnopqrstuvwxyz</span>
          <span className="is-symbol">ABCDEFGHIJKLMNOPQRSTUVWXYZ</span>
          <span className="is-chinese is-size-1">WeQ装扮管理器</span>
          <span className="is-chinese is-size-2">WeQ装扮管理器</span>
          <span className="is-chinese is-size-3">WeQ装扮管理器</span>
          <span className="is-chinese is-size-4">WeQ装扮管理器</span>
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

/** Web 版把服务端生成的文件拉成浏览器下载；桌面版已在主进程落盘。 */
function startWebDownload(downloadId: string | null | undefined, name: string): void {
  if (!downloadId) return;
  const link = document.createElement('a');
  link.href = `/_download/${encodeURIComponent(downloadId)}`;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function MessageDecorationCard({ decoration, onClose }: MessageDecorationCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const save = trpc.account.dressup.saveMsgDecoration.useMutation();
  const pushToast = useToast((s) => s.push);
  const [saving, setSaving] = useState<DecorationKind | 'all' | null>(null);

  const hasDecoration =
    decoration && (decoration.fontId || decoration.bubbleId || decoration.widgetId);
  const items: DecorationItemRow[] = [];

  if (decoration?.fontId) {
    items.push({
      type: 'font' as const,
      id: decoration.fontId,
      label: '字体',
      icon: <Type size={18} />,
    });
  }
  if (decoration?.bubbleId) {
    items.push({
      type: 'bubble' as const,
      id: decoration.bubbleId,
      label: '气泡',
      icon: <MessageCircle size={18} />,
    });
  }
  if (decoration?.widgetId) {
    items.push({
      type: 'widget' as const,
      id: decoration.widgetId,
      label: '挂件',
      icon: <Sparkles size={18} />,
    });
  }

  async function saveDecoration(kind?: DecorationKind): Promise<void> {
    if (!decoration || saving) return;
    const key = kind ?? 'all';
    const label = kind ? items.find((item) => item.type === kind)?.label : null;
    setSaving(key);
    try {
      const result = await save.mutateAsync({
        bubbleId: decoration.bubbleId,
        fontId: decoration.fontId,
        widgetId: decoration.widgetId,
        ...(kind ? { kind } : {}),
      });
      if (result.canceled) return;
      startWebDownload(result.downloadId, result.name);
      pushToast({
        tone: 'success',
        title: kind ? `已保存${label}资源` : '已保存全部装扮',
        message: result.downloadId ? '已开始下载' : result.path,
        ttl: 6000,
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: kind ? `${label}装扮保存失败` : '装扮保存失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <OverlayLayer presentation="popover" className="weq-profile-layer" onClose={onClose}>
      <section
        ref={cardRef}
        className="weq-profile-dialog weq-decoration-card weq-anim-pop"
        style={{
          maxWidth: '800px',
          width: '90%',
        }}
        role="dialog"
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

        <div className="weq-decoration-card-titlebar">
          <div className="weq-decoration-card-title">
            <Palette size={20} strokeWidth={2} />
            <span>消息装扮</span>
          </div>
          {hasDecoration ? (
            <button
              type="button"
              className="weq-decoration-card-save-all"
              title="把这条消息用到的装扮资源打包另存"
              disabled={saving !== null}
              onClick={() => void saveDecoration()}
            >
              {saving === 'all' ? (
                <Loader2 size={14} className="weq-decoration-card-spin" />
              ) : (
                <Download size={14} />
              )}
              另存全部
            </button>
          ) : null}
        </div>

        {!hasDecoration ? (
          <div className="weq-decoration-card-empty-state">
            <Palette size={48} strokeWidth={1.5} opacity={0.3} />
            <span>此消息未使用装扮</span>
          </div>
        ) : (
          <div className="weq-decoration-card-grid">
            {items.map((item) => (
              <div className="weq-decoration-card-slot" key={item.type}>
                <DecorationItem type={item.type} id={item.id} label={item.label} icon={item.icon} />
                <button
                  type="button"
                  className="weq-decoration-card-save"
                  title={`把${item.label}资源另存为文件`}
                  disabled={saving !== null}
                  onClick={() => void saveDecoration(item.type)}
                >
                  {saving === item.type ? (
                    <Loader2 size={13} className="weq-decoration-card-spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  另存为
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </OverlayLayer>
  );
}
