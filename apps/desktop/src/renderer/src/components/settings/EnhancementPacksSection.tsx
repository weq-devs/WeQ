import { useState } from 'react';
import {
  AudioLines,
  BrainCircuit,
  Download,
  Package,
  Palette,
  RefreshCw,
  ScanText,
  Trash2,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useAppDialog } from '../../lib/dialogUtils';
import type { EnhancementPackId } from '../../../../shared/enhancement_manifest';
import { Card, QueryError, SectionHeader } from './controls';
import { LoadingIndicator } from '../LoadingIndicator';

export function enhancementBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
const ICONS = { text: ScanText, voice: AudioLines, intent: BrainCircuit, dress: Palette };

export function EnhancementPacksSection() {
  const active = useTabActive();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const query = trpc.bootstrap.enhancementPacks.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (data) => (active && data?.packs.some((pack) => pack.busy) ? 750 : false),
  });
  const [error, setError] = useState<string | null>(null);
  const prepare = trpc.bootstrap.prepareEnhancementPacks.useMutation();
  const remove = trpc.bootstrap.deleteEnhancementPack.useMutation();
  const packs = query.data?.packs ?? [];
  async function refresh() {
    await Promise.all([
      utils.bootstrap.enhancementPacks.invalidate(),
      utils.bootstrap.localModelResources.invalidate(),
      utils.bootstrap.getLocalEngine.invalidate(),
      utils.bootstrap.getSettings.invalidate(),
      utils.account.intentSense.getStatus.invalidate(),
    ]);
  }
  async function download(ids: EnhancementPackId[]) {
    setError(null);
    try {
      await prepare.mutateAsync({ ids });
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function erase(id: EnhancementPackId) {
    const pack = packs.find((entry) => entry.id === id)!;
    const confirmed = await dialog.confirm(
      `删除${pack.name}？`,
      `将移除 ${enhancementBytes(pack.deleteBytes)} 本地资源，下次使用需重新下载。功能设置、已有识别与分析结果、具体装扮素材，以及其他能力使用的共享资源会保留。`,
      { okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (!confirmed) return;
    setError(null);
    try {
      await remove.mutateAsync({ id });
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader
        title="增强包"
        icon={<Package size={18} strokeWidth={1.8} />}
        pageReset={false}
        desc="减少对在线服务的依赖：识别、转写与分析可在本机完成，装扮资源也不再依赖 QQ 在线查询。"
        actions={
          packs.some((pack) => !pack.downloaded && !pack.blocker && !pack.busy) ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={prepare.isLoading || !query.data}
              onClick={() =>
                void download(
                  packs.filter((pack) => !pack.blocker && !pack.downloaded).map((pack) => pack.id),
                )
              }
            >
              <Download size={14} />
              下载全部 {enhancementBytes(query.data?.all.downloadBytes ?? 0)}
            </button>
          ) : undefined
        }
      />
      {query.isLoading ? <LoadingIndicator /> : null}
      {query.error ? (
        <QueryError
          message={query.error.message}
          retryLabel="重新读取增强包"
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {error ? (
        <p role="alert" className="weq-set-note">
          {error}
        </p>
      ) : null}
      {packs.map((pack) => {
        const Icon = ICONS[pack.id];
        const operation = pack.operation;
        const status =
          operation?.phase === 'checking'
            ? '正在检查'
            : operation?.phase === 'queued'
              ? '等待准备'
              : operation?.phase === 'removing'
                ? '正在删除'
                : operation?.paused
                  ? '已暂停'
                  : '正在下载';
        const actionLabel = operation?.phase === 'failed' ? '重试' : '下载';
        const percent = operation?.total
          ? Math.min(100, Math.max(0, (operation.received / operation.total) * 100))
          : 0;
        return (
          <Card
            key={pack.id}
            title={pack.name}
            desc={pack.description}
            icon={<Icon size={15} strokeWidth={1.8} />}
            settingId={`enhancement-${pack.id}`}
            action={
              pack.downloaded ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft weq-set-btn-sm weq-number w-40! h-8! shrink-0"
                  title={`删除${pack.name}`}
                  aria-label={`删除${pack.name}`}
                  disabled={pack.busy || remove.isLoading}
                  onClick={() => void erase(pack.id)}
                >
                  <Trash2 size={14} />
                  删除 {enhancementBytes(pack.deleteBytes)}
                </button>
              ) : !pack.busy && !pack.blocker ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft weq-set-btn-sm weq-number w-40! h-8! shrink-0"
                  disabled={prepare.isLoading}
                  aria-label={actionLabel + pack.name}
                  onClick={() => void download([pack.id])}
                >
                  {operation?.phase === 'failed' ? <RefreshCw size={14} /> : <Download size={14} />}
                  {actionLabel} {enhancementBytes(pack.downloadBytes)}
                </button>
              ) : null
            }
          >
            {pack.busy ? (
              <div className="weq-set-progress">
                <div
                  className="weq-set-progress-track"
                  role="progressbar"
                  aria-label={`${pack.name}准备进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={operation?.phase === 'checking' ? undefined : Math.round(percent)}
                >
                  <div
                    className="weq-set-progress-fill"
                    style={{ width: `${operation?.phase === 'checking' ? 100 : percent}%` }}
                  />
                </div>
                <div className="weq-set-progress-meta weq-number">
                  <span>{operation?.note ?? status}</span>
                  {operation?.total ? (
                    <span>
                      {enhancementBytes(operation.received)} / {enhancementBytes(operation.total)}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
            {pack.blocker || operation?.error ? (
              <p className="weq-set-note" role="alert">
                {pack.blocker ?? operation?.error}
              </p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
