/**
 * 设置 → 模型与识别 → 语音与图片识别（本地模型）.
 *
 * 这一屏只管**模型的下载与选择**：识别模型（PP-OCR，出逐行文字 + 像素坐标框）和
 * 筛图模型（只判断「图里有没有文字」，用于批量 OCR 前先筛掉风景 / 人像）。识别模型
 * 已经接进图片灯箱的 OCR 按钮（在线那条路走不通时在本机跑）；筛图模型先用不着 ——
 * 导出侧的批量自动 OCR 是单独一轮的事。
 *
 * 与语音模型共用资源配置（`bootstrap.getSettings().modelResources`），下载进度
 * 走 `onOcrModelProgress` 这一条共享订阅，注册表 + 落盘状态来自
 * `bootstrap.localModelResources`。
 *
 * Freshness：和其它设置面板一样用 `staleTime: 0` + `refetchOnMount: 'always'`，
 * 重新打开设置总是拿到最新状态。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AlertTriangle, Check, Download, Loader2, ScanText, Trash2 } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, SectionHeader } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bytes → "x.x MB". */
function fmtBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/** Bytes/sec → "x.x MB/s". */
function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return '';
  const mb = bps / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

/** Live progress for the model currently downloading (null when idle). */
interface LiveProgress {
  id: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
}

/** 一条模型记录的展示字段（渲染层只需要这些）。 */
interface ModelRow {
  id: string;
  name: string;
  desc: string;
  sizeLabel: string;
  sizeOnDisk: number;
  downloaded: boolean;
  recommended: boolean;
}

interface ModelKindCardProps {
  title: string;
  /** 这张卡是干什么的（一句话）。 */
  desc: string;
  /** 注册表里这一类为空时显示什么。 */
  emptyHint: string;
  /** 「不选」意味着什么 —— 空选择的语义两类模型不一样。 */
  unselectedHint: string;
  models: ModelRow[];
  selectedId: string;
  progress: LiveProgress | null;
  busy: boolean;
  /**
   * 本机没有可用的推理引擎时的那句话（平台能力，与模型下没下好无关）。非空即收起
   * 整个模型列表与下载 / 选用入口 —— 这台上跑不起来，下了也是白下。
   */
  engineBlocker: string | null;
  onDownload(id: string): void;
  onDelete(id: string): void;
  onSelect(id: string): void;
}

/** 一类模型的卡片（识别 / 筛图共用同一套渲染）。 */
function ModelKindCard({
  title,
  desc,
  emptyHint,
  unselectedHint,
  models,
  selectedId,
  progress,
  busy,
  engineBlocker,
  onDownload,
  onDelete,
  onSelect,
}: ModelKindCardProps): ReactElement {
  return (
    <Card title={title}>
      <p className="weq-set-note">{desc}</p>
      {engineBlocker ? (
        <p className="weq-set-warnbox">
          <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
          <span>{engineBlocker}</span>
        </p>
      ) : models.length === 0 ? (
        <div className="weq-set-empty">{emptyHint}</div>
      ) : (
        <div className="weq-models">
          {models.map((m) => {
            const isSelected = selectedId === m.id;
            const isDownloading = progress?.id === m.id;
            const pct = isDownloading ? Math.round(progress.percent) : 0;
            return (
              <div key={m.id} className={`weq-model${isSelected ? ' is-selected' : ''}`}>
                <div className="weq-model-icon">
                  <ScanText size={18} strokeWidth={1.8} aria-hidden />
                </div>
                <div className="weq-model-main">
                  <div className="weq-model-head">
                    <span className="weq-model-name">{m.name}</span>
                    {m.recommended ? (
                      <span className="weq-set-badge weq-set-badge-ok">推荐</span>
                    ) : null}
                    {m.downloaded ? <span className="weq-set-badge">已下载</span> : null}
                    {isSelected ? (
                      <span className="weq-set-badge weq-set-badge-ok">当前选用</span>
                    ) : null}
                  </div>
                  <span className="weq-model-desc">{m.desc}</span>
                  <span className="weq-model-size weq-number">
                    {m.downloaded ? `占用 ${fmtBytes(m.sizeOnDisk)}` : `约 ${m.sizeLabel}`}
                  </span>

                  {isDownloading ? (
                    <div className="weq-set-progress">
                      <div className="weq-set-progress-track">
                        <div className="weq-set-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="weq-set-progress-meta weq-number">
                        <span>{pct}%</span>
                        <span>
                          {fmtBytes(progress.downloadedBytes)} / {fmtBytes(progress.totalBytes)}
                          {progress.speed > 0 ? ` · ${fmtSpeed(progress.speed)}` : ''}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="weq-model-actions">
                  {m.downloaded ? (
                    <>
                      <button
                        type="button"
                        className={`weq-set-btn weq-set-btn-sm${isSelected ? ' weq-set-btn-soft' : ''}`}
                        onClick={() => onSelect(m.id)}
                        disabled={busy}
                      >
                        <Check size={12} strokeWidth={2} aria-hidden />
                        {isSelected ? '取消选用' : '设为当前'}
                      </button>
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                        onClick={() => onDelete(m.id)}
                        disabled={busy || isDownloading}
                        title="删除模型"
                        aria-label="删除模型"
                      >
                        <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                      </button>
                    </>
                  ) : isDownloading ? (
                    <button type="button" className="weq-set-btn weq-set-btn-sm" disabled>
                      <Loader2 size={12} strokeWidth={2} className="weq-spin" aria-hidden />
                      下载中
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      onClick={() => onDownload(m.id)}
                      disabled={Boolean(progress)}
                    >
                      <Download size={12} strokeWidth={1.8} aria-hidden />
                      下载
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {engineBlocker ? null : <p className="weq-set-note">{unselectedHint}</p>}
    </Card>
  );
}

export function OcrModelsSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();

  const models = trpc.bootstrap.localModelResources.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const download = trpc.bootstrap.downloadOcrModel.useMutation();
  const remove = trpc.bootstrap.deleteOcrModel.useMutation();
  const setModel = trpc.bootstrap.setLocalModelResource.useMutation();

  const [progress, setProgress] = useState<LiveProgress | null>(null);

  // 订阅只建一次；refetch/showError 通过 ref 取最新引用，避免它们的身份变化把流重连。
  const refetchModelsRef = useRef(models.refetch);
  refetchModelsRef.current = models.refetch;
  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  useEffect(() => {
    const sub = client.bootstrap.onOcrModelProgress.subscribe(undefined, {
      onData: (p) => {
        if (p.error) {
          setProgress(null);
          void refetchModelsRef.current();
          showErrorRef.current('模型下载失败', p.error);
          return;
        }
        if (p.done) {
          setProgress(null);
          void refetchModelsRef.current();
          return;
        }
        setProgress({
          id: p.id,
          percent: p.percent,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          speed: p.speed,
        });
      },
      onError: (err) => console.error('[ocr] progress subscription error', err),
    });
    return () => sub.unsubscribe();
  }, []);

  const selectedOcr = models.data?.selected.ocr ?? '';
  const selectedFilter = models.data?.selected.filter ?? '';

  async function onDownload(id: string): Promise<void> {
    try {
      setProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0 });
      await download.mutateAsync({ id });
    } catch (e) {
      setProgress(null);
      showError('启动下载失败', errMsg(e));
    }
  }

  /** 删掉的正好是当前选用的话，顺手把选择也清掉（否则会指向一个不存在的模型）。 */
  async function onDelete(id: string): Promise<void> {
    try {
      const removed = await remove.mutateAsync({ id });
      if (!removed) throw new Error('模型正在下载，暂不能删除');
      await models.refetch();
      await utils.bootstrap.getSettings.invalidate();
    } catch (e) {
      showError('删除模型失败', errMsg(e));
    }
  }

  async function onSelect(id: string, kind: 'ocr' | 'filter', selectedId: string): Promise<void> {
    try {
      // Toggle off if already selected.
      await setModel.mutateAsync({ kind, modelId: selectedId === id ? '' : id });
      await models.refetch();
      await utils.bootstrap.getSettings.invalidate();
    } catch (e) {
      showError('设置当前模型失败', errMsg(e));
    }
  }

  const all = models.data?.ocr ?? [];
  /** 平台能力：本机没有推理引擎时（如 macOS Intel）整屏只留一句原因。 */
  const engineBlocker = models.data?.engineBlocker ?? null;
  const ocrModels = all.filter((m) => m.kind === 'ocr');
  const filterModels = all.filter((m) => m.kind === 'filter');
  const busy = remove.isLoading || setModel.isLoading;

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<ScanText size={18} strokeWidth={1.8} />}
        title="本地图片识别模型"
        desc="本地图片文字识别（OCR）的模型下载与选择。识别模型出文字和每行文字的像素坐标框；筛图模型只判断「图里有没有文字」，用在批量识别之前把没有文字的图先筛掉。"
      />

      <ModelKindCard
        title="识别模型"
        desc="负责真正把图上的文字读出来（检测 + 方向分类 + 识别）。"
        emptyHint={models.isLoading ? '加载中…' : '暂无可用模型'}
        unselectedHint="不选 = 不做本地文字识别。"
        models={ocrModels}
        selectedId={selectedOcr}
        progress={progress}
        busy={busy}
        engineBlocker={engineBlocker}
        onDownload={(id) => void onDownload(id)}
        onDelete={(id) => void onDelete(id)}
        onSelect={(id) => void onSelect(id, 'ocr', selectedOcr)}
      />

      <ModelKindCard
        title="筛图模型"
        desc="只回答「这张图里有没有文字」，比识别模型轻得多：批量识别（例如导出时自动 OCR）之前先跑一遍，风景照 / 人像这类直接跳过。"
        emptyHint={models.isLoading ? '加载中…' : '暂无可用模型'}
        unselectedHint="不选 = 不过滤，每张图都会送进识别模型。"
        models={filterModels}
        selectedId={selectedFilter}
        progress={progress}
        busy={busy}
        engineBlocker={engineBlocker}
        onDownload={(id) => void onDownload(id)}
        onDelete={(id) => void onDelete(id)}
        onSelect={(id) => void onSelect(id, 'filter', selectedFilter)}
      />

      <p className="weq-set-note">
        QQ 在线 OCR 由 QQ 服务端提供，不是本地模型，不占用此处模型资源。
        模型保存在本地，删除「账号缓存」不会影响它。识别模型下好之后，聊天图片灯箱的
        「OCR」按钮就会在在线那条路走不通时用它出文字；筛图模型留给导出侧的批量自动
        识别，现在只负责下载与选择。
      </p>
    </div>
  );
}
