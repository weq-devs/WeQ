import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Loader2, ScanText } from 'lucide-react';
import type { OcrBlock } from '@weq/protocol';
import { trpc } from '../trpc/client';
import { OcrTextPanel } from './OcrTextPanel';
import { useToast } from './Toast';
import type { LightboxOcrContext } from './mediaPreviewTypes';

/** OCR 只挂载到图片与工具栏插槽，不重挂载媒体外壳或播放器。 */
export function PreviewOcr({
  src,
  context,
  frame,
  actions,
  size,
  ready,
}: {
  src: string;
  context: LightboxOcrContext;
  frame: HTMLElement;
  actions: HTMLElement;
  size: { width: number; height: number };
  ready: boolean;
}) {
  const ocr = usePreviewOcr(src, context);
  return (
    <>
      {createPortal(
        <>
          {ocr.overlay(size.width, size.height)}
          {ocr.busy}
        </>,
        frame,
      )}
      {createPortal(ocr.controls(ready), actions)}
      {ocr.panel}
    </>
  );
}

/** 每次展示独立持有 OCR 结果，失效请求不能回写到下一张图片。 */
export function usePreviewOcr(src: string, context: LightboxOcrContext | null | undefined) {
  const [result, setResult] = useState<{
    blocks: OcrBlock[];
    width: number;
    height: number;
    source: 'oidb' | 'local';
    cached: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(true);
  const [panel, setPanel] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setBusy(false);
    setVisible(true);
    setPanel(false);
    return () => {
      generation.current++;
    };
  }, [src, context]);
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled: Boolean(context),
    refetchOnWindowFocus: true,
    staleTime: 4000,
    refetchInterval: context ? 5000 : false,
  });
  const cache = trpc.account.ocrCacheLookup.useQuery(
    { md5: context?.md5 ?? '' },
    {
      enabled: Boolean(context?.md5),
      staleTime: 4000,
      refetchOnWindowFocus: true,
    },
  );
  const mutation = trpc.account.ocrChatImage.useMutation();
  const state = access.data;
  const expired = Boolean(context?.expiresAt && context.expiresAt < Date.now());
  const online = Boolean(
    state?.qqOnline &&
      state.attachEnabled &&
      state.hasA2 &&
      state.hasD2 &&
      state.hasD2Key &&
      state.hasGuid &&
      !expired,
  );
  const available = Boolean(context && (online || state?.ocrLocalModelId || cache.data?.hit));
  const hint = online
    ? '识别图片里的文字（在线）'
    : state?.ocrLocalModelId
      ? '识别图片里的文字（本地模型）'
      : cache.data?.hit
        ? '读取本机缓存的识别结果'
        : state?.ocrLocalBlocker || '需要在线 QQ 或可用的本地识别模型';
  async function run() {
    if (!context || busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const value = await mutation.mutateAsync({ ...context, src });
      if (request !== generation.current) return;
      setResult({
        blocks: value.blocks,
        width: value.imageWidth || context.width,
        height: value.imageHeight || context.height,
        source: value.source ?? 'oidb',
        cached: value.cached === true,
      });
      setVisible(true);
      setPanel(value.blocks.length > 0);
      if (!value.blocks.length) useToast.getState().push({ tone: 'info', title: '没识别到文字' });
    } catch (error) {
      if (request === generation.current)
        useToast.getState().push({
          tone: 'error',
          title: '文字识别失败',
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  return {
    overlay(width: number, height: number) {
      if (!result || !visible || !width || !height || !result.width || !result.height) return null;
      const sx = width / result.width,
        sy = height / result.height;
      return (
        <div className="weq-ocr-overlay">
          {result.blocks.map((block) => {
            const h = Math.max(1, block.rect.height * sy);
            return (
              <span
                className="weq-ocr-cover"
                key={`${block.parag}:${block.rect.x}:${block.rect.y}:${block.text}`}
                style={{
                  left: block.rect.x * sx,
                  top: block.rect.y * sy,
                  width: Math.max(1, block.rect.width * sx),
                  height: h,
                  fontSize: Math.max(9, Math.min(48, h * 0.64)),
                }}
              >
                {block.text}
              </span>
            );
          })}
        </div>
      );
    },
    busy: busy ? (
      <div className="weq-ocr-busy" role="status">
        <Loader2 className="weq-spin" />
        <span>正在识别文字…</span>
      </div>
    ) : null,
    controls(ready: boolean) {
      return context ? (
        <>
          <button
            className="weq-lightbox-action"
            type="button"
            title={hint}
            disabled={!ready || !available || busy}
            onClick={() => void run()}
          >
            {busy ? <Loader2 className="weq-spin" size={15} /> : <ScanText size={15} />}
            {result ? '重新识别' : 'OCR'}
          </button>
          {result && result.blocks.length > 0 ? (
            <>
              <button
                type="button"
                className="weq-lightbox-action"
                onClick={() => setVisible(!visible)}
                title={visible ? '查看原图' : '查看识别结果'}
              >
                {visible ? <Eye size={15} /> : <EyeOff size={15} />}
                {visible ? '原始' : '结果'}
              </button>
              <button type="button" className="weq-lightbox-action" onClick={() => setPanel(true)}>
                <ScanText size={15} />
                文字
              </button>
            </>
          ) : null}
        </>
      ) : null;
    },
    panel:
      panel && result ? (
        <OcrTextPanel
          blocks={result.blocks}
          source={result.source}
          cached={result.cached}
          onExit={() => {
            setPanel(false);
            setResult(null);
          }}
        />
      ) : null,
  };
}
