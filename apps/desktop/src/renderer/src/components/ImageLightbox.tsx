/**
 * Full-screen image lightbox — click a chat image to view it large.
 *
 *   - openLightbox(src, alt?, ocr?)  imperative open; opening the SAME src that's
 *     already shown is a no-op, so clicking one image repeatedly never stacks
 *     multiple overlays (built-in de-dup).
 *   - <ImageLightbox/>               mount once near the root; renders the overlay
 *     for whatever the store currently holds (a single global portal).
 *
 * Click the backdrop or press ESC to close. Scroll to zoom (anchored at the
 * cursor), click the image to toggle 2× zoom, drag to pan when zoomed.
 *
 * 窗口下面那条操作条（图片专属，视频那侧只有「另存为」）：
 *   - OCR          —— 只有带 `ocr` 上下文的图（聊天里出现过的图片）才有：要 `fileToken`
 *                     现签一条 CDN 直链交给 OIDB 0xe07_0。识别期间整张图上盖一层转圈；
 *                     出结果后把每段文字以**不透明文本框**盖回原位，并配一枚「眼镜」
 *                     在 OCR 前后之间切换。
 *   - 另存为        —— 主进程弹保存对话框写盘。
 *   - 复制到剪贴板   —— 主进程 clipboard.writeImage 写系统剪贴板。
 * OCR 的前置条件与「发送键」同口径：QQ 在线 + 未开完全离线模式 + 发包物料齐全
 * （getGroupAlbumAccessState），缺一项就把按钮置灰并说明原因。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Copy, Download, Eye, EyeOff, Loader2, ScanText, X } from 'lucide-react';
import type { OcrBlock } from '@weq/protocol';
import { trpc } from '@renderer/trpc/client';
import { useOverlayLayer } from '../lib/overlayStack';
import { exportMedia } from '../lib/mediaExport';
import { OcrTextPanel } from './OcrTextPanel';
import { useToast } from './Toast';
import { useZoomPan } from './useZoomPan';

/**
 * 图片的「可 OCR」上下文 —— 只有聊天消息里的图片拿得到（元素里带 `fileToken`）。
 * 其他入口（群相册 / 收藏 / 本地资源）不传，OCR 按钮就不出现。
 */
export interface LightboxOcrContext {
  peerType: 'c2c' | 'group';
  fileToken: string;
  width: number;
  height: number;
  md5?: string;
  fileSize?: number;
}

interface LightboxStore {
  src: string | null;
  alt: string;
  ocr: LightboxOcrContext | null;
  open(src: string, alt?: string, ocr?: LightboxOcrContext | null): void;
  close(): void;
}

const useLightbox = create<LightboxStore>((set, get) => ({
  src: null,
  alt: '',
  ocr: null,
  open(src, alt = '', ocr = null) {
    if (!src || get().src === src) return; // de-dup: same image already open
    set({ src, alt, ocr });
  },
  close() {
    set({ src: null, alt: '', ocr: null });
  },
}));

/** Open the lightbox for `src`. No-op if that exact src is already showing. */
export function openLightbox(src: string, alt?: string, ocr?: LightboxOcrContext | null): void {
  useLightbox.getState().open(src, alt, ocr);
}

/** Mount once. Renders the active large-image overlay, if any. */
export function ImageLightbox(): ReactElement | null {
  const src = useLightbox((s) => s.src);
  const alt = useLightbox((s) => s.alt);
  const ocrContext = useLightbox((s) => s.ocr);
  const close = useLightbox((s) => s.close);
  const zoom = useZoomPan(src);
  const layer = useOverlayLayer(src !== null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  /** 图片渲染后的实际像素尺寸（缩放用 transform，不影响 offsetWidth）。 */
  const [rendered, setRendered] = useState({ width: 0, height: 0 });
  const [blocks, setBlocks] = useState<OcrBlock[] | null>(null);
  /** 「眼镜」：在 OCR 前后之间切换（true = 看识别结果）。 */
  const [showOverlay, setShowOverlay] = useState(true);
  /** 纯文本面板是否展开（识别成功后自动展开）。 */
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // OCR 能力门禁：和「发送键」共用同一份在线 / 物料状态。
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled: src !== null && ocrContext !== null,
    refetchOnWindowFocus: true,
    staleTime: 4000,
    refetchInterval: 5000,
  });
  const ocrMutation = trpc.account.ocrChatImage.useMutation();

  // 换图（或关闭再开）时把 OCR 状态复位，别把上一张的结果带到新图上。
  useEffect(() => {
    setBlocks(null);
    setPanelOpen(false);
    setBusy(false);
    setShowOverlay(true);
    setRendered({ width: 0, height: 0 });
  }, [src]);

  useEffect(() => {
    if (!src) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [src, close]);

  /** 量一下图片渲染尺寸：覆盖层要按它把回包坐标（原图像素）换算成屏幕像素。 */
  const measure = useCallback(() => {
    const el = imageRef.current;
    if (!el) return;
    setRendered({ width: el.offsetWidth, height: el.offsetHeight });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, src]);

  const accessData = access.data;
  const canOcr = Boolean(
    ocrContext &&
      accessData?.qqOnline &&
      accessData.attachEnabled &&
      accessData.hasA2 &&
      accessData.hasD2 &&
      accessData.hasD2Key &&
      accessData.hasGuid,
  );
  const ocrHint = !ocrContext
    ? '只有聊天里出现过的图片能识别文字'
    : canOcr
      ? '识别图片里的文字'
      : 'QQ 未在线或发包物料不全，暂不可识别';

  async function runOcr(): Promise<void> {
    if (!ocrContext) return;
    setBusy(true);
    try {
      const result = await ocrMutation.mutateAsync(ocrContext);
      setBlocks(result.blocks);
      setShowOverlay(true);
      setPanelOpen(true);
      measure();
      if (result.blocks.length === 0) {
        useToast.getState().push({ tone: 'info', title: '没识别到文字' });
      }
    } catch (error) {
      useToast.getState().push({
        tone: 'error',
        title: '文字识别失败',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<void> {
    const result = await exportMedia({ url: src ?? '', name: alt }, 'save');
    if (result.ok || result.canceled) return;
    useToast.getState().push({ tone: 'error', title: '另存为失败', message: result.error });
  }

  async function onCopy(): Promise<void> {
    const result = await exportMedia({ url: src ?? '', name: alt }, 'clipboard');
    useToast
      .getState()
      .push(
        result.ok
          ? { tone: 'success', title: '已复制到剪贴板' }
          : { tone: 'error', title: '复制失败', message: result.error },
      );
  }

  if (typeof document === 'undefined' || !src) return null;

  // 覆盖层：把每段文字按回包坐标（原图像素）铺到渲染后的图上。缩放是 transform，
  // 所以这里只要按「渲染尺寸 / 原图尺寸」线性换算即可，跟着一起缩放。
  const scaleX = rendered.width && ocrContext?.width ? rendered.width / ocrContext.width : 0;
  const scaleY = rendered.height && ocrContext?.height ? rendered.height / ocrContext.height : 0;
  const overlayVisible = Boolean(blocks && blocks.length > 0 && showOverlay && scaleX && scaleY);

  return createPortal(
    <div className="weq-lightbox-layer weq-anim-fade" style={{ zIndex: layer }} onMouseDown={close}>
      <button className="weq-lightbox-close" type="button" onClick={close} aria-label="关闭">
        <X size={22} />
      </button>
      <div className="weq-lightbox-stage-wrap weq-anim-pop">
        <div className="weq-lightbox-stage" onMouseDown={(event) => event.stopPropagation()}>
          {/* 缩放 / 平移挂在 frame 上：图片和盖在它上面的 OCR 层一起动。 */}
          <div
            ref={zoom.setEl}
            className="weq-lightbox-frame"
            style={zoom.style}
            onMouseDown={zoom.onMouseDown}
          >
            <img
              ref={imageRef}
              className="weq-lightbox-image"
              src={src}
              alt={alt}
              draggable={false}
              onLoad={measure}
            />
            {overlayVisible ? (
              <div className="weq-ocr-overlay">
                {blocks?.map((block) => {
                  const height = Math.max(1, block.rect.height * scaleY);
                  return (
                    <span
                      className="weq-ocr-cover"
                      key={`${block.parag}|${block.text}|${block.rect.x},${block.rect.y}`}
                      style={{
                        left: block.rect.x * scaleX,
                        top: block.rect.y * scaleY,
                        width: Math.max(1, block.rect.width * scaleX),
                        height,
                        fontSize: Math.max(9, Math.min(48, height * 0.64)),
                      }}
                    >
                      {block.text}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {busy ? (
              <div className="weq-ocr-busy" role="status">
                <span className="weq-ocr-spinner" aria-hidden />
                <span className="weq-ocr-busy-text">正在识别文字…</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="weq-lightbox-actions" onMouseDown={(event) => event.stopPropagation()}>
          {ocrContext ? (
            <button
              className="weq-lightbox-action weq-lightbox-action-primary"
              type="button"
              title={ocrHint}
              disabled={!canOcr || busy}
              onClick={() => void runOcr()}
            >
              {busy ? <Loader2 className="weq-spin" size={15} /> : <ScanText size={15} />}
              {blocks ? '重新识别' : 'OCR'}
            </button>
          ) : null}
          {blocks && blocks.length > 0 ? (
            <>
              <button
                className="weq-lightbox-action weq-lightbox-action-accent"
                type="button"
                title={showOverlay ? '看原图（OCR 前）' : '看识别结果（OCR 后）'}
                onClick={() => setShowOverlay((prev) => !prev)}
              >
                {showOverlay ? <Eye size={15} /> : <EyeOff size={15} />}
                {showOverlay ? '原始' : '结果'}
              </button>
              <button
                className="weq-lightbox-action"
                type="button"
                title="打开纯文本面板"
                onClick={() => setPanelOpen(true)}
              >
                <ScanText size={15} />
                文字
              </button>
            </>
          ) : null}
          {ocrContext ? <span className="weq-lightbox-action-sep" aria-hidden /> : null}
          <button
            className="weq-lightbox-action"
            type="button"
            title="另存为"
            onClick={() => void onSave()}
          >
            <Download size={15} />
            另存为
          </button>
          <button
            className="weq-lightbox-action"
            type="button"
            title="复制到剪贴板"
            onClick={() => void onCopy()}
          >
            <Copy size={15} />
            复制
          </button>
        </div>
      </div>
      {panelOpen && blocks && blocks.length > 0 ? (
        <OcrTextPanel
          blocks={blocks}
          onExit={() => {
            setPanelOpen(false);
            setBlocks(null);
            setShowOverlay(true);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
