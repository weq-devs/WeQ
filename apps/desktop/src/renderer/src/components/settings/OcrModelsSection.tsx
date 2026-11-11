/**
 * 设置 → 模型与识别 → 图片识别（本地模型）.
 *
 * 这一屏管理模型的下载与删除：识别模型读出文字，筛图模型判断图里有没有文字。
 * 完整下载的模型由后台自动启用，不再单独选择。
 *
 * 与语音模型共用资源配置（`bootstrap.getSettings().modelResources`），下载进度
 * 走 `onOcrModelProgress` 这一条共享订阅，注册表 + 落盘状态来自
 * `bootstrap.localModelResources`。
 *
 * Freshness：和其它设置面板一样用 `staleTime: 0` + `refetchOnMount: 'always'`，
 * 重新打开设置总是拿到最新状态。
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, Cloud, Download, Loader2, ScanText, Trash2 } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { Card, SectionHeader } from './controls';
import { RecognitionConcurrencySetting } from './RecognitionConcurrencySetting';
import { LoadingIndicator } from '../LoadingIndicator';

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
  downloading?: boolean;
  recommended: boolean;
}

interface ModelKindSectionProps {
  title: string;
  /** 这组模型的用途。 */
  desc: string;
  /** 注册表里这一类为空时显示什么。 */
  emptyHint: ReactNode;
  models: ModelRow[];
  progress: LiveProgress | null;
  busy: boolean;
  /**
   * 本机没有可用的推理引擎时的那句话（平台能力，与模型下没下好无关）。非空即收起
   * 整个模型列表与下载 / 选用入口 —— 这台上跑不起来，下了也是白下。
   */
  engineBlocker: string | null;
  onDownload(id: string): void;
  onDelete(id: string): void;
}

/** 本地模型卡片内按用途分组，不另嵌套设置卡片。 */
function ModelKindSection({
  title,
  desc,
  emptyHint,
  models,
  progress,
  busy,
  engineBlocker,
  onDownload,
  onDelete,
}: ModelKindSectionProps): ReactElement {
  return (
    <section className="weq-recognition-model-group" aria-label={title}>
      <h4>{title}</h4>
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
            const hasProgress = progress?.id === m.id;
            const isDownloading = hasProgress || m.downloading;
            const pct = hasProgress ? Math.round(progress.percent) : 0;
            return (
              <div key={m.id} className="weq-model">
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
                  </div>
                  <span className="weq-model-desc">{m.desc}</span>
                  <span className="weq-model-size weq-number">
                    {m.downloaded ? `占用 ${fmtBytes(m.sizeOnDisk)}` : `约 ${m.sizeLabel}`}
                  </span>

                  {hasProgress ? (
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
    </section>
  );
}

export function OcrModelsSection(): ReactElement {
  const active = useTabActive();
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();

  const models = trpc.bootstrap.localModelResources.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const download = trpc.bootstrap.downloadOcrModel.useMutation();
  const remove = trpc.bootstrap.deleteOcrModel.useMutation();

  const [progress, setProgress] = useState<LiveProgress | null>(null);

  // 订阅只建一次；refetch/showError 通过 ref 取最新引用，避免它们的身份变化把流重连。
  const refetchModelsRef = useRef<() => void>(() => {});
  refetchModelsRef.current = () => {
    void models.refetch();
    void utils.bootstrap.getSettings.invalidate();
  };
  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    let current = true;
    const sub = client.bootstrap.onOcrModelProgress.subscribe(undefined, {
      onData: (p) => {
        if (!current) return;
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
    return () => {
      current = false;
      sub.unsubscribe();
    };
  }, [active]);

  async function onDownload(id: string): Promise<void> {
    try {
      setProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0 });
      await download.mutateAsync({ id });
    } catch (e) {
      setProgress(null);
      showError('启动下载失败', errMsg(e));
    }
  }

  /** 删除后由后台重新检查剩余可用模型。 */
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

  const all = models.data?.ocr ?? [];
  /** 平台能力：本机没有推理引擎时（如 macOS Intel）整屏只留一句原因。 */
  const engineBlocker = models.data?.engineBlocker ?? null;
  const ocrModels = all.filter((m) => m.kind === 'ocr');
  const filterModels = all.filter((m) => m.kind === 'filter');
  const busy = remove.isLoading || models.isFetching;

  return (
    <div className="weq-set weq-recognition-settings">
      <SectionHeader icon={<ScanText size={18} strokeWidth={1.8} />} title="图片识别" />
      <Card title="QQ 在线识别" icon={<Cloud size={15} strokeWidth={1.8} />}>
        <p className="weq-set-note">由 QQ 服务端识别图片文字，需要 QQ 在线及对应凭据。</p>
        <RecognitionConcurrencySetting kind="ocr" />
      </Card>

      <Card title="本地图片识别" icon={<ScanText size={15} strokeWidth={1.8} />}>
        <ModelKindSection
          title="识别模型"
          desc="检测图片中的文字位置并识别内容。"
          emptyHint={models.isLoading ? <LoadingIndicator /> : '暂无可用模型'}
          models={ocrModels}
          progress={progress}
          busy={busy}
          engineBlocker={engineBlocker}
          onDownload={(id) => void onDownload(id)}
          onDelete={(id) => void onDelete(id)}
        />

        <ModelKindSection
          title="筛图模型"
          desc="识别前先判断图片是否包含文字，跳过无文字图片以减少处理量。"
          emptyHint={models.isLoading ? <LoadingIndicator /> : '暂无可用模型'}
          models={filterModels}
          progress={progress}
          busy={busy}
          engineBlocker={engineBlocker}
          onDownload={(id) => void onDownload(id)}
          onDelete={(id) => void onDelete(id)}
        />

        <p className="weq-set-note">本地模型用于离线识别，删除「账号缓存」不会影响这些资源。</p>
      </Card>
    </div>
  );
}
