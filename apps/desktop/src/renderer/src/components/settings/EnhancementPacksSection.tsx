import { useContext, useState } from 'react';
import {
  AudioLines,
  BrainCircuit,
  Download,
  Package,
  Palette,
  RefreshCw,
  ScanText,
  Trash2,
  Pause,
  Play,
  Settings2,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useAppDialog } from '../../lib/dialogUtils';
import type { EnhancementPackId } from '../../../../shared/enhancement_manifest';
import { Card, QueryError, SectionHeader, Row, Toggle, SettingsNavigateContext } from './controls';
import { LoadingIndicator } from '../LoadingIndicator';
import '../../styles/enhancement-packs.css';

export function enhancementBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
const ICONS = { text: ScanText, voice: AudioLines, intent: BrainCircuit, dress: Palette };

export function EnhancementPacksSection() {
  const active = useTabActive();
  const dialog = useAppDialog();
  const navigate = useContext(SettingsNavigateContext);
  const utils = trpc.useUtils();
  const check = trpc.bootstrap.checkEnhancementUpdates.useMutation();
  const query = trpc.bootstrap.enhancementPacks.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (data) =>
      active &&
      (check.isLoading ||
        data?.packs.some(
          (pack) =>
            pack.busy ||
            pack.check?.phase === 'checking' ||
            pack.check?.phase === 'waiting-network',
        ))
        ? 750
        : false,
  });
  const [error, setError] = useState<string | null>(null);
  const prepare = trpc.bootstrap.prepareEnhancementPacks.useMutation();
  const remove = trpc.bootstrap.deleteEnhancementPack.useMutation();
  const settings = trpc.bootstrap.setEnhancementUpdates.useMutation();
  const pause = trpc.bootstrap.pauseEnhancementPack.useMutation();
  const resume = trpc.bootstrap.resumeEnhancementPack.useMutation();
  const packs = query.data?.packs ?? [];
  const preferences = query.data?.preferences ?? { autoCheck: true, autoInstall: false };
  async function refresh() {
    await Promise.all([
      utils.bootstrap.enhancementPacks.invalidate(),
      utils.bootstrap.localModelResources.invalidate(),
      utils.bootstrap.getLocalEngine.invalidate(),
      utils.bootstrap.getSettings.invalidate(),
      utils.account.intentSense.getStatus.invalidate(),
    ]);
  }
  async function act(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await refresh();
    }
  }
  async function erase(id: EnhancementPackId) {
    const pack = packs.find((entry) => entry.id === id)!;
    const confirmed = await dialog.confirm(
      `删除${pack.name}？`,
      `将移除 ${enhancementBytes(pack.deleteBytes)} 本地资源，下次使用需重新下载。功能设置、已有识别与分析结果、具体装扮素材，以及其他能力使用的共享资源会保留。`,
      { danger: 'outline', okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (confirmed) await act(() => remove.mutateAsync({ id }));
  }
  return (
    <div className="weq-set">
      <SectionHeader title="增强包" page="enhancement-packs" />
      <Card
        title="增强包自动更新"
        icon={<Settings2 size={15} />}
        settingId="enhancement-updates"
        resetId="enhancement-updates"
      >
        <Row
          settingId="enhancement-auto-check"
          control={
            <Toggle
              label="自动检查增强包更新"
              checked={preferences.autoCheck}
              disabled={!query.data || settings.isLoading}
              onChange={(autoCheck) => void act(() => settings.mutateAsync({ autoCheck }))}
            />
          }
        />
        {preferences.autoCheck ? (
          <Row
            settingId="enhancement-auto-install"
            indent
            control={
              <Toggle
                label="自动安装增强包更新"
                checked={preferences.autoInstall}
                disabled={!query.data || settings.isLoading}
                onChange={(autoInstall) => void act(() => settings.mutateAsync({ autoInstall }))}
              />
            }
          />
        ) : null}
      </Card>
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
      <Card title="增强包管理" icon={<Package size={15} />} settingId="enhancement-management">
        <ul className="weq-enhancement-list">
          {packs.map((pack) => {
            const Icon = ICONS[pack.id];
            const operation = pack.operation;
            const checking =
              pack.check?.phase === 'checking' ||
              (check.isLoading && check.variables?.ids.includes(pack.id));
            const percent = operation?.total
              ? Math.min(100, Math.max(0, (operation.received / operation.total) * 100))
              : undefined;
            const status = pack.busy
              ? operation?.paused
                ? operation.pauseReasons?.includes('user')
                  ? '已暂停'
                  : '省流量模式已暂停'
                : operation?.retryAt && operation.retryAt > Date.now()
                  ? '等待自动重试'
                  : (operation?.note ?? '正在准备')
              : checking
                ? '正在检查更新'
                : pack.check?.phase === 'waiting-network'
                  ? '等待网络允许检查'
                  : pack.needsRepair
                    ? '待补齐'
                    : pack.check?.phase === 'checked'
                      ? pack.updateAvailable
                        ? '有可用更新'
                        : '已检查'
                      : null;
            const issue = pack.blocker ?? operation?.error ?? pack.check?.error;
            const missing = pack.missingComponents?.length
              ? `缺少或损坏：${pack.missingComponents.join('、')}`
              : undefined;
            const updating = pack.updateAvailable && !pack.needsRepair && !pack.blocker;
            return (
              <li
                className="weq-enhancement-item"
                key={pack.id}
                data-setting-id={`enhancement-${pack.id}`}
              >
                <span className="weq-enhancement-icon" aria-hidden>
                  <Icon size={18} strokeWidth={1.8} />
                </span>
                <div className="weq-enhancement-main">
                  <span className="weq-enhancement-name">{pack.name}</span>
                  <span className="weq-enhancement-description">{pack.description}</span>
                </div>
                <span
                  className="weq-enhancement-size weq-number"
                  title={
                    pack.sharedBytes
                      ? `含 ${enhancementBytes(pack.sharedBytes)} 共享资源`
                      : '空间占用'
                  }
                >
                  {enhancementBytes(pack.sizeOnDisk)}
                </span>
                <div
                  className="weq-enhancement-actions"
                  role="group"
                  aria-label={`${pack.name}操作`}
                >
                  {!pack.downloaded ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      title={`${pack.needsRepair ? '补齐' : '下载'}${pack.name} · ${enhancementBytes(pack.downloadBytes)}${missing ? `\n${missing}` : ''}`}
                      aria-label={`${pack.needsRepair ? '补齐' : '下载'}${pack.name}`}
                      disabled={pack.busy || !!pack.blocker || prepare.isLoading}
                      onClick={() => void act(() => prepare.mutateAsync({ ids: [pack.id] }))}
                    >
                      <Download size={14} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    title={
                      updating
                        ? `更新${pack.name} · ${enhancementBytes(pack.downloadBytes)}`
                        : `检查${pack.name}更新`
                    }
                    aria-label={updating ? `更新${pack.name}` : `检查${pack.name}更新`}
                    disabled={pack.busy || (updating && prepare.isLoading)}
                    onClick={() =>
                      void act(() =>
                        updating
                          ? prepare.mutateAsync({ ids: [pack.id] })
                          : check.mutateAsync({ ids: [pack.id] }),
                      )
                    }
                  >
                    {updating ? <Download size={14} /> : <RefreshCw size={14} />}
                  </button>
                  {pack.downloaded || pack.installed || pack.sizeOnDisk > 0 ? (
                    <button
                      data-danger="outline"
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      title={`删除${pack.name}`}
                      aria-label={`删除${pack.name}`}
                      disabled={pack.busy || remove.isLoading}
                      onClick={() => void erase(pack.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </div>
                {pack.busy ? (
                  <div className="weq-enhancement-progress">
                    <progress
                      max={100}
                      value={operation?.phase === 'checking' ? undefined : percent}
                      aria-label={`${pack.name}准备进度`}
                    />
                    <span className="weq-number">
                      {operation?.total
                        ? `${enhancementBytes(operation.received)} / ${enhancementBytes(operation.total)}`
                        : status}
                    </span>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      title={operation?.paused ? '继续下载' : '暂停'}
                      aria-label={`${operation?.paused ? '继续' : '暂停'}${pack.name}`}
                      disabled={operation?.phase === 'installing'}
                      onClick={() =>
                        void act(() =>
                          operation?.paused
                            ? resume.mutateAsync({ id: pack.id })
                            : pause.mutateAsync({ id: pack.id }),
                        )
                      }
                    >
                      {operation?.paused ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                    {operation?.total ? (
                      <span className="weq-enhancement-phase" title={operation?.source}>
                        {status}
                        {operation?.source ? ` · ${operation.source}` : ''}
                      </span>
                    ) : null}
                  </div>
                ) : status ? (
                  <span className="weq-enhancement-status" title={missing} role="status">
                    {status}
                  </span>
                ) : null}
                {issue ? (
                  <p className="weq-enhancement-issue" role="alert">
                    {issue}
                    {pack.requiresWeqUpdate ? (
                      <>
                        {' '}
                        <a
                          href="#settings/version"
                          onClick={(event) => {
                            if (navigate) {
                              event.preventDefault();
                              navigate('version');
                            }
                          }}
                        >
                          前往 WeQ 更新
                        </a>
                      </>
                    ) : operation?.phase === 'failed' ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="weq-enhancement-retry"
                          onClick={() => void act(() => prepare.mutateAsync({ ids: [pack.id] }))}
                        >
                          重试
                        </button>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
