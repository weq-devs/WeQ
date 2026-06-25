/**
 * 设置 → 语音转录.
 *
 * Account-independent: downloads & selects the offline transcription model used
 * by the chat 转文字 feature. The selected model id lives in the global config
 * (`bootstrap.getSettings().voiceTranscribe.modelId`); empty = feature off.
 *
 * Download progress arrives over the `onVoiceModelProgress` subscription (one
 * shared stream for all models, keyed by model id). The model registry +
 * on-disk status come from `bootstrap.voiceModels`.
 *
 * Freshness: like the other settings panels, queries use `staleTime: 0` +
 * `refetchOnMount: 'always'` so reopening the dialog always shows fresh state.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { AudioLines, Check, Download, Loader2, Trash2 } from 'lucide-react';
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

export function VoiceTranscribeSection(): ReactElement {
  const showError = useDialog((s) => s.showError);

  const models = trpc.bootstrap.voiceModels.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const download = trpc.bootstrap.downloadVoiceModel.useMutation();
  const remove = trpc.bootstrap.deleteVoiceModel.useMutation();
  const setModel = trpc.bootstrap.setVoiceModel.useMutation();

  const [progress, setProgress] = useState<LiveProgress | null>(null);

  // Subscribe to download progress (shared stream). On the terminal event
  // (done/error) clear the bar and refresh the model list.
  useEffect(() => {
    const sub = client.bootstrap.onVoiceModelProgress.subscribe(undefined, {
      onData: (p) => {
        if (p.error) {
          setProgress(null);
          void models.refetch();
          showError('模型下载失败', p.error);
          return;
        }
        if (p.done) {
          setProgress(null);
          void models.refetch();
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
      onError: (err) => console.error('[voice] progress subscription error', err),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedId = settings.data?.voiceTranscribe.modelId ?? '';

  async function onDownload(id: string): Promise<void> {
    try {
      setProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0 });
      await download.mutateAsync({ id });
    } catch (e) {
      setProgress(null);
      showError('启动下载失败', errMsg(e));
    }
  }

  async function onDelete(id: string): Promise<void> {
    try {
      await remove.mutateAsync({ id });
      // If the deleted model was selected, clear the selection too.
      if (selectedId === id) await setModel.mutateAsync({ modelId: '' });
      await models.refetch();
      await settings.refetch();
    } catch (e) {
      showError('删除模型失败', errMsg(e));
    }
  }

  async function onSelect(id: string): Promise<void> {
    try {
      // Toggle off if already selected.
      await setModel.mutateAsync({ modelId: selectedId === id ? '' : id });
      await settings.refetch();
    } catch (e) {
      showError('设置当前模型失败', errMsg(e));
    }
  }

  const modelList = models.data ?? [];

  return (
    <div className="weq-set">
      <SectionHeader
        title="语音转录"
        desc="下载并选择离线语音识别模型。选中后，聊天中的语音消息将出现「转文字」按钮。"
      />

      <Card title="转录模型">
        {modelList.length === 0 ? (
          <div className="weq-set-empty">{models.isLoading ? '加载中…' : '暂无可用模型'}</div>
        ) : (
          <div className="weq-voice-models">
            {modelList.map((m) => {
              const isSelected = selectedId === m.id;
              const isDownloading = progress?.id === m.id;
              const pct = isDownloading ? Math.round(progress!.percent) : 0;
              return (
                <div key={m.id} className={`weq-voice-model${isSelected ? ' is-selected' : ''}`}>
                  <div className="weq-voice-model-icon">
                    <AudioLines size={18} strokeWidth={1.8} aria-hidden />
                  </div>
                  <div className="weq-voice-model-main">
                    <div className="weq-voice-model-head">
                      <span className="weq-voice-model-name">{m.name}</span>
                      {m.recommended ? <span className="weq-set-badge weq-set-badge-ok">推荐</span> : null}
                      {m.downloaded ? <span className="weq-set-badge">已下载</span> : null}
                      {isSelected ? <span className="weq-set-badge weq-set-badge-ok">当前模型</span> : null}
                    </div>
                    <span className="weq-voice-model-desc">{m.desc}</span>
                    <span className="weq-voice-model-size weq-number">
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
                            {fmtBytes(progress!.downloadedBytes)} / {fmtBytes(progress!.totalBytes)}
                            {progress!.speed > 0 ? ` · ${fmtSpeed(progress!.speed)}` : ''}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="weq-voice-model-actions">
                    {m.downloaded ? (
                      <>
                        <button
                          type="button"
                          className={`weq-set-btn weq-set-btn-sm${isSelected ? ' weq-set-btn-soft' : ''}`}
                          onClick={() => void onSelect(m.id)}
                          disabled={setModel.isLoading}
                        >
                          <Check size={12} strokeWidth={2} aria-hidden />
                          {isSelected ? '取消选用' : '设为当前'}
                        </button>
                        <button
                          type="button"
                          className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                          onClick={() => void onDelete(m.id)}
                          disabled={remove.isLoading || isDownloading}
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
                        onClick={() => void onDownload(m.id)}
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
        <p className="weq-set-note">
          模型文件较大，请在网络良好时下载。模型保存在本地，删除「账号缓存」不会影响它。
        </p>
      </Card>
    </div>
  );
}
