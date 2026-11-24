import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, FileText, Loader2, MoreHorizontal, ScanText } from 'lucide-react';
import { ToolbarLabel } from './CompactToolbar';
import type { OcrBlock } from '@weqbot/protocol';
import { trpc } from '../trpc/client';
import { OcrTextPanel } from './OcrTextPanel';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { useToastApi } from './Toast.shared';
import type { PreviewOcrContext } from './mediaPreviewTypes';

/** 每次展示独立持有 OCR 结果，失效请求不能回写到下一张图片。 */
export function usePreviewOcr(
  src: string,
  context: PreviewOcrContext | null | undefined,
  originalSrc?: string,
) {
  const notificationToast = useToastApi();
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
  const [resultsMenu, setResultsMenu] = useState<{ x: number; y: number } | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setBusy(false);
    setVisible(true);
    setPanel(false);
    setResultsMenu(null);
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
  const canRun = result ? Boolean(context && (online || state?.ocrLocalModelId)) : available;
  const hint = online
    ? '识别图片里的文字（在线）'
    : state?.ocrLocalModelId
      ? '识别图片里的文字（本地模型）'
      : cache.data?.hit
        ? '读取本机缓存的识别结果'
        : state?.ocrLocalBlocker || '需要在线 QQ 或可用的本地识别模型';
  async function run() {
    if (!context || busy || !canRun) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const value = await mutation.mutateAsync({
        ...context,
        src,
        originalSrc,
        refresh: result !== null,
      });
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
      if (!value.blocks.length)
        notificationToast.push({ tone: 'info', durationKind: 'success', title: '没识别到文字' });
    } catch (error) {
      if (request === generation.current)
        notificationToast.push({
          tone: 'error',
          title: '文字识别失败',
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  const toggleResults = () => setVisible((previous) => !previous);
  const closeMenu = () => {
    setResultsMenu(null);
    moreButton.current?.focus({ preventScroll: true });
  };
  const toggleLabel = visible ? '查看原图' : '查看识别结果';
  const ToggleIcon = visible ? Eye : EyeOff;
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
            title={result && !canRun ? '重新识别需要在线 QQ 或可用的本地识别模型' : hint}
            disabled={!ready || !canRun || busy}
            onClick={() => void run()}
          >
            {busy ? <Loader2 className="weq-spin" size={15} /> : <ScanText size={15} />}
            <ToolbarLabel>{result ? '重新识别' : 'OCR'}</ToolbarLabel>
          </button>
          {result && result.blocks.length > 0 ? (
            <>
              <span data-toolbar-overflow-actions="">
                <button
                  type="button"
                  className="weq-lightbox-action"
                  onClick={toggleResults}
                  title={toggleLabel}
                >
                  <ToggleIcon size={15} aria-hidden />
                  <ToolbarLabel>{visible ? '原始' : '结果'}</ToolbarLabel>
                </button>
                <button
                  type="button"
                  className="weq-lightbox-action"
                  title="打开识别文字"
                  onClick={() => setPanel(true)}
                >
                  <FileText size={15} aria-hidden />
                  <ToolbarLabel>文字</ToolbarLabel>
                </button>
              </span>
              <button
                ref={moreButton}
                type="button"
                className="weq-lightbox-action"
                data-toolbar-overflow-trigger=""
                title="更多文字识别操作"
                aria-label="更多文字识别操作"
                aria-expanded={resultsMenu !== null}
                aria-haspopup="menu"
                onClick={(event) => {
                  if (resultsMenu) return closeMenu();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setResultsMenu({ x: rect.right, y: rect.top - 4 });
                }}
              >
                <MoreHorizontal size={16} aria-hidden />
              </button>
              {resultsMenu ? (
                <ConversationActionsMenu
                  {...resultsMenu}
                  dropdown="above"
                  label="文字识别操作"
                  onClose={closeMenu}
                  actions={[
                    { label: toggleLabel, icon: <ToggleIcon size={15} />, action: toggleResults },
                    {
                      label: '打开识别文字',
                      icon: <FileText size={15} />,
                      action: () => setPanel(true),
                    },
                  ]}
                />
              ) : null}
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
            setResultsMenu(null);
            setPanel(false);
            setResult(null);
          }}
        />
      ) : null,
  };
}
