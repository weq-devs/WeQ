import { useState, type ReactElement } from 'react';
import { BrainCircuit, Download, Play } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, Row, SectionHeader } from './controls';

/** 全局资源管理与按账号的意图功能开关分开，未打开账号也可以下载。 */
export function IntentModelsSection({ embedded = false }: { embedded?: boolean }): ReactElement {
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  const resources = trpc.bootstrap.localModelResources.useQuery();
  const engine = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const select = trpc.bootstrap.setLocalModelResource.useMutation();
  const download = trpc.bootstrap.downloadLocalModel.useMutation();
  const start = trpc.bootstrap.startLocalEngine.useMutation();
  const [mirror, setMirror] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  trpc.bootstrap.onModelDownloadProgress.useSubscription(undefined, {
    onData: (p) => {
      setProgress(
        p.done
          ? null
          : `${p.filesDone}/${p.filesTotal} · ${(p.received / 1024 / 1024).toFixed(0)} MB`,
      );
      if (p.done) void utils.bootstrap.getLocalEngine.invalidate();
    },
  });
  const busy = select.isLoading || download.isLoading || engine.data?.downloading || !!progress;
  const selected = resources.data?.selected.intent ?? 'auto';
  const downloadable = engine.data?.models.find((m) => m.id === selected)?.downloadable;

  async function refresh(): Promise<void> {
    await utils.bootstrap.localModelResources.invalidate();
    await utils.bootstrap.getLocalEngine.invalidate();
    await utils.bootstrap.getSettings.invalidate();
    await utils.account.intentSense.getLocalEngine.invalidate();
    await utils.account.intentSense.getStatus.invalidate();
  }

  async function choose(modelId: string): Promise<void> {
    try {
      await select.mutateAsync({ kind: 'intent', modelId });
      await refresh();
    } catch (error) {
      showError('选择模型失败', String(error));
    }
  }

  async function run(action: 'download' | 'start'): Promise<void> {
    try {
      const result =
        action === 'download' ? await download.mutateAsync({ mirror }) : await start.mutateAsync();
      if (!result.ok) throw new Error(result.error ?? '操作失败');
    } catch (error) {
      showError(action === 'download' ? '模型下载失败' : '引擎启动失败', String(error));
    } finally {
      setProgress(null);
      await refresh();
    }
  }

  return (
    <div className={embedded ? undefined : 'weq-set'}>
      {!embedded ? <SectionHeader icon={<BrainCircuit size={18} />} title="意图模型" /> : null}
      <Card title="意图模型资源（全局）">
        <Row
          label="当前模型"
          control={
            <select
              className="weq-set-input"
              aria-label="意图模型资源"
              value={selected}
              disabled={busy || !engine.data?.available || !resources.data}
              onChange={(event) => void choose(event.target.value)}
            >
              {(engine.data?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                  {model.downloaded ? ' · 已就绪' : ''}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="状态"
          desc={
            !engine.data?.available
              ? '本地引擎仅桌面版可用'
              : engine.data.modelDownloaded
                ? `模型已就绪 · ${engine.data.modelDir.includes('QWeQ-NineBird') ? 'QWeQ-NineBird-v1' : 'Laya 多语言 ONNX'}`
                : '模型尚未就绪'
          }
          control={null}
        />
        {engine.data?.available && !engine.data.modelDownloaded && downloadable ? (
          <>
            <Row
              label="hf-mirror.com 镜像"
              control={
                <input
                  type="checkbox"
                  aria-label="使用下载镜像"
                  checked={mirror}
                  disabled={busy}
                  onChange={(event) => setMirror(event.target.checked)}
                />
              }
            />
            <button
              type="button"
              className="weq-set-btn"
              disabled={busy}
              onClick={() => void run('download')}
            >
              <Download size={14} />
              {busy ? (progress ?? '下载中…') : '下载模型'}
            </button>
          </>
        ) : null}
        {engine.data?.modelDownloaded ? (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy || start.isLoading || engine.data.engineReady}
            onClick={() => void run('start')}
          >
            <Play size={14} />
            {engine.data.engineReady ? '引擎已就绪' : '启动引擎'}
          </button>
        ) : null}
      </Card>
    </div>
  );
}
