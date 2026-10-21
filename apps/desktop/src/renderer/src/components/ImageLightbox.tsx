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
 *   - OCR          —— 只有带 `ocr` 上下文的图（聊天里出现过的图片）才有：优先走在线
 *                     OIDB 0xe07_0（要 `fileToken` 现签一条 CDN 直链），QQ 不在线 /
 *                     没有发包凭据时回退到本地模型（模型要在设置里下好，见 main/ocr）。
 *                     识别期间整张图上盖一层转圈；出结果后把每段文字以**不透明文本框**
 *                     盖回原位，并配一枚「眼镜」在 OCR 前后之间切换。
 *   - 另存为        —— 主进程弹保存对话框写盘。
 *   - 复制到剪贴板   —— 主进程 clipboard.writeImage 写系统剪贴板。
 * 按钮能不能点由 `getGroupAlbumAccessState` 决定：在线那条腿要 QQ 在线 + 未开完全离线
 * 模式 + 发包物料齐全；本地那条腿只要模型下好了（`ocrLocalModelId`）。两条都不行才置灰。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Copy, Eye, EyeOff, Loader2, ScanText, X } from 'lucide-react';
import type { OcrBlock } from '@weq/protocol';
import { trpc } from '@renderer/trpc/client';
import { useOverlayLayer } from '../lib/overlayStack';
import { exportMedia } from '../lib/mediaExport';
import { OcrTextPanel } from './OcrTextPanel';
import { useToast } from './Toast';
import { useZoomPan } from './useZoomPan';
import { resourceForRenderDocument } from '../lib/renderDocument';
import { MediaSourceSave } from './MediaSaveControls';

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
  /**
   * 服务端副本的到期时刻（ms）—— 元素里 uploadTimestamp + fileTTL 算出来的。
   * QQ 的图片链接实测只保留 9 天（777600 秒），过期后 OCR 必然失败：URL 是**交给服务端
   * 去取图**的，本地缓存救不回来。所以这里提前把按钮拦掉，别让用户白等一轮。
   */
  expiresAt?: number;
}

interface LightboxStore {
  src: string | null;
  alt: string;
  ocr: LightboxOcrContext | null;
  ownerDocument: Document | null;
  onClosed?: () => void;
  open(
    src: string,
    alt?: string,
    ocr?: LightboxOcrContext | null,
    ownerDocument?: Document,
    onClosed?: () => void,
  ): void;
  close(): void;
}

const useLightbox = create<LightboxStore>((set, get) => ({
  src: null,
  alt: '',
  ocr: null,
  ownerDocument: null,
  open(src, alt = '', ocr = null, ownerDocument = document, onClosed) {
    if (!src || (get().src === src && get().ownerDocument === ownerDocument)) return;
    set({ src, alt, ocr, ownerDocument, onClosed });
  },
  close() {
    const onClosed = get().onClosed;
    set({ src: null, alt: '', ocr: null, ownerDocument: null, onClosed: undefined });
    onClosed?.();
  },
}));

/** Open the lightbox for `src`. No-op if that exact src is already showing. */
export function openLightbox(
  src: string,
  alt?: string,
  ocr?: LightboxOcrContext | null,
  ownerDocument?: Document,
  onClosed?: () => void,
): void {
  const target = ownerDocument ?? document;
  useLightbox.getState().open(resourceForRenderDocument(src, target), alt, ocr, target, onClosed);
}

/** Mount once. Renders the active large-image overlay, if any. */
export function ImageLightbox(): ReactElement | null {
  const document = useLightbox((state) => state.ownerDocument) ?? globalThis.document;
  const viewport = document.defaultView ?? window;
  const src = useLightbox((s) => s.src);
  const alt = useLightbox((s) => s.alt);
  const ocrContext = useLightbox((s) => s.ocr);
  const close = useLightbox((s) => s.close);
  const zoom = useZoomPan(src);
  const layer = useOverlayLayer(src !== null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  /** 图片渲染后的实际像素尺寸（缩放用 transform，不影响 offsetWidth）。 */
  const [rendered, setRendered] = useState({ width: 0, height: 0 });
  const [blocks, setBlocks] = useState<OcrBlock[] | null>(null);
  /**
   * 结果自带的坐标系（被识别那张图的像素尺寸）。**不能直接用 `ocrContext` 的宽高**：
   * 本地那条腿拿到的可能是落盘的缩略图（元素里记的却是原图尺寸），按回包的尺寸换算才不错位。
   */
  const [ocrSize, setOcrSize] = useState<{ width: number; height: number } | null>(null);
  /** 这批结果是从哪条腿来的（在线 OIDB / 本地模型）—— 面板上标出来，方便对账。 */
  const [source, setSource] = useState<'oidb' | 'local' | null>(null);
  /** 这批结果是不是本机缓存直接给的（面板副标题标「缓存」，也不报「本地模型用时」）。 */
  const [cached, setCached] = useState(false);
  /** 「眼镜」：在 OCR 前后之间切换（true = 看识别结果）。 */
  const [showOverlay, setShowOverlay] = useState(true);
  /** 纯文本面板是否展开（识别成功后自动展开）。 */
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (src) layerRef.current?.focus({ preventScroll: true });
  }, [src, document]);

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
    setOcrSize(null);
    setSource(null);
    setCached(false);
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
  }, [src, close, document]);

  /** 量一下图片渲染尺寸：覆盖层要按它把回包坐标（原图像素）换算成屏幕像素。 */
  const measure = useCallback(() => {
    const el = imageRef.current;
    if (!el) return;
    setRendered({ width: el.offsetWidth, height: el.offsetHeight });
  }, []);

  useEffect(() => {
    measure();
    viewport.addEventListener('resize', measure);
    return () => viewport.removeEventListener('resize', measure);
  }, [measure, src, viewport]);
  useEffect(() => {
    viewport.addEventListener('pagehide', close);
    return () => viewport.removeEventListener('pagehide', close);
  }, [viewport, close]);

  // 滚轮缩放挂在**整块灯箱**上（不只图片那点面积）：以前只有光标正好在图上才缩放，
  // 图占不满屏时四周暗底滚轮毫无反应，用起来像「滚轮坏了」。文字面板与操作条要留给
  // 自己的滚动 / 点击，所以那两处直接放行；落在图片上的由 useZoomPan 自己的监听处理
  // （这里跳过，避免同一个事件被算两次）。
  const wheelAt = zoom.wheelAt;
  useEffect(() => {
    const node = layerRef.current;
    if (!node || !src) return;
    const onWheel = (event: WheelEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.weq-lightbox-frame, .weq-ocr-panel, .weq-lightbox-actions')) return;
      event.preventDefault();
      wheelAt(event.clientX, event.clientY, event.deltaY);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [src, wheelAt]);

  const accessData = access.data;
  /**
   * 本机结果缓存里有没有这张图（键是图片 md5，与导出 / MCP 共用同一份）。
   * 只有能算出 md5 的图才查得动 —— 查得到就多一条「不用联网也不用模型」的路。
   */
  const cacheLookup = trpc.account.ocrCacheLookup.useQuery(
    { md5: ocrContext?.md5 ?? '' },
    {
      enabled: src !== null && Boolean(ocrContext?.md5),
      staleTime: 4000,
      refetchOnWindowFocus: true,
    },
  );
  const cachedReady = cacheLookup.data?.hit === true;
  /** 服务端副本已过期（QQ 只留约 9 天）—— 这种图 OCR 必然失败，直接拦。 */
  const serverExpired = Boolean(ocrContext?.expiresAt && ocrContext.expiresAt < Date.now());
  /** 在线那条腿（OIDB 0xe07_0）齐不齐 —— 与主进程的 `ocrOnlineBlocker` 同口径。 */
  const onlineReady = Boolean(
    accessData?.qqOnline &&
      accessData.attachEnabled &&
      accessData.hasA2 &&
      accessData.hasD2 &&
      accessData.hasD2Key &&
      accessData.hasGuid,
  );
  /** 本地那条腿：设置里选了识别模型且已经下好。 */
  const localReady = Boolean(accessData?.ocrLocalModelId);
  /**
   * 本机没有可用的推理引擎时的原因（如 macOS Intel 没有 onnxruntime 二进制）。
   * 有它就别再劝用户「去下个本地模型」—— 那台机器上下完也跑不起来。
   */
  const localBlocker = accessData?.ocrLocalBlocker ?? null;
  const useOnline = onlineReady && !serverExpired;
  const canOcr = Boolean(ocrContext && (useOnline || localReady || cachedReady));
  const ocrHint = !ocrContext
    ? '只有聊天里出现过的图片能识别文字'
    : useOnline
      ? '识别图片里的文字（在线）'
      : localReady
        ? '识别图片里的文字（本地模型）'
        : cachedReady
          ? '直接给本机缓存的识别结果（这张图以前识别过）'
          : localBlocker
            ? localBlocker
            : serverExpired
              ? '这张图的服务端副本已过期（QQ 只保留约 9 天），也没下本地识别模型'
              : '需要在线 QQ，或先在「设置 → 模型与识别 → 图片识别」里下好本地识别模型';

  async function runOcr(): Promise<void> {
    if (!ocrContext) return;
    setBusy(true);
    try {
      const result = await ocrMutation.mutateAsync({ ...ocrContext, src: src ?? undefined });
      setBlocks(result.blocks);
      setOcrSize({
        width: result.imageWidth || ocrContext.width,
        height: result.imageHeight || ocrContext.height,
      });
      setSource(result.source ?? 'oidb');
      setCached(result.cached === true);
      setShowOverlay(true);
      setPanelOpen(true);
      measure();
      if (result.blocks.length === 0) {
        useToast.getState().push({
          tone: 'info',
          title: '没识别到文字',
          ...(result.cached ? { message: '（本机缓存里这条结果就是空文字）' } : {}),
        });
      } else if (result.cached) {
        // 缓存命中是瞬时的：别报「本地模型用时 3.2s」，那是当初那次的耗时。
        useToast.getState().push({
          tone: 'info',
          title: `直接用了本机缓存的结果 · ${result.blocks.length} 段`,
          message: '这张图以前识别过（灯箱 / 导出 / MCP 哪一条都算），没有再跑一遍。',
        });
      } else if (result.source === 'local') {
        // 本地那条腿慢（CPU 推理），把耗时说出来，免得好端端一个转圈让人以为卡死了。
        const seconds = result.elapsedMs ? `${(result.elapsedMs / 1000).toFixed(1)}s` : '';
        useToast.getState().push({
          tone: 'info',
          title: `本地模型识别完成 · ${result.blocks.length} 段`,
          message: seconds ? `用时 ${seconds}` : undefined,
        });
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

  async function onCopy(): Promise<void> {
    const result = await exportMedia({ url: src ?? '', name: alt }, 'clipboard', document);
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
  const baseWidth = ocrSize?.width ?? ocrContext?.width ?? 0;
  const baseHeight = ocrSize?.height ?? ocrContext?.height ?? 0;
  const scaleX = rendered.width && baseWidth ? rendered.width / baseWidth : 0;
  const scaleY = rendered.height && baseHeight ? rendered.height / baseHeight : 0;
  const overlayVisible = Boolean(blocks && blocks.length > 0 && showOverlay && scaleX && scaleY);

  return createPortal(
    <div
      ref={layerRef}
      className="weq-lightbox-layer weq-anim-fade"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `图片预览：${alt}` : '图片预览'}
      tabIndex={-1}
      style={{ zIndex: layer }}
      onMouseDown={close}
    >
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
          <MediaSourceSave
            key={src}
            source={{ kind: 'url', url: src, name: alt }}
            className="weq-lightbox-action"
            label="保存图片"
            ownerDocument={document}
          />
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
          source={source ?? undefined}
          cached={cached}
          onExit={() => {
            setPanelOpen(false);
            setBlocks(null);
            setOcrSize(null);
            setSource(null);
            setCached(false);
            setShowOverlay(true);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
