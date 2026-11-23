import { useContext, useState } from 'react';
import { TaskProgressBar } from '../tasks/TaskProgressBar';
import { timeDate } from '@weq/time';
import {
  AudioLines,
  BrainCircuit,
  Download,
  ListTodo,
  Package,
  Palette,
  RefreshCw,
  ScanText,
  Trash2,
  Pause,
  Play,
  Settings2,
  Sticker,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { useAppDialog } from '../../lib/dialogUtils';
import type { EnhancementPackId } from '../../../../shared/enhancement_manifest';
import { Card, QueryError, SectionHeader, Row, Toggle } from './controls';
import { SettingsNavigateContext } from './controls.shared';
import { LoadingIndicator } from '../LoadingIndicator';
import { TimeLabel } from '../TimeLabel';
import '../../styles/enhancement-packs.css';
import { enhancementBytes } from './EnhancementPacksSection.shared';

const ICONS = {
  text: ScanText,
  voice: AudioLines,
  intent: BrainCircuit,
  dress: Palette,
  'market-emoji': Sticker,
};

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
  const background = trpc.bootstrap.backgroundEnhancementPack.useMutation();
  const packs = query.data?.packs ?? [];
  const preferences = query.data?.preferences ?? { autoCheck: true, autoInstall: false };
  async function refresh() {
    await Promise.all([
      utils.bootstrap.enhancementPacks.invalidate(),
      utils.bootstrap.localModelResources.invalidate(),
      utils.bootstrap.getLocalEngine.invalidate(),
      utils.bootstrap.getSettings.invalidate(),
      utils.account.marketEmoji.searchCatalog.invalidate(),
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
  const preparePack = (id: EnhancementPackId) =>
    prepare.mutateAsync({ ids: [id], foreground: true });
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
            const task = pack.downloadTask;
            const waiting = !pack.busy && task?.status === 'paused';
            const paused = operation?.paused || waiting;
            const checking =
              pack.check?.phase === 'checking' ||
              (check.isLoading && check.variables?.ids.includes(pack.id));
            const checkedAt = timeDate(pack.check?.checkedAt);
            const percent = operation?.total
              ? Math.min(100, Math.max(0, (operation.received / operation.total) * 100))
              : task?.progress;
            const status = pack.busy
              ? operation?.paused
                ? operation.pauseReasons?.includes('user')
                  ? '已暂停'
                  : '省流量模式已暂停'
                : operation?.retryAt && operation.retryAt > Date.now()
                  ? '等待自动重试'
                  : (operation?.note ?? '正在准备')
              : waiting
                ? (task.statusLabel ?? '等待继续')
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
            const issue =
              pack.blocker ??
              operation?.error ??
              (task?.status === 'failed' ? task.note : undefined) ??
              pack.check?.error;
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
                      onClick={() => void act(() => preparePack(pack.id))}
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
                        updating ? preparePack(pack.id) : check.mutateAsync({ ids: [pack.id] }),
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
                {pack.busy || waiting ? (
                  <div className="weq-enhancement-progress">
                    <TaskProgressBar
                      value={operation?.phase === 'checking' ? undefined : percent}
                      label={`${pack.name}准备进度`}
                    />
                    <span className="weq-number">
                      {operation?.total
                        ? `${enhancementBytes(operation.received)} / ${enhancementBytes(operation.total)}`
                        : status}
                    </span>
                    <div className="weq-enhancement-progress-actions">
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft"
                        title={paused ? '继续下载' : '暂停'}
                        aria-label={`${paused ? '继续' : '暂停'}${pack.name}`}
                        disabled={
                          operation?.phase === 'installing' ||
                          prepare.isLoading ||
                          Boolean(waiting && pack.blocker)
                        }
                        onClick={() =>
                          void act(() =>
                            waiting
                              ? preparePack(pack.id)
                              : paused
                                ? resume.mutateAsync({ id: pack.id })
                                : pause.mutateAsync({ id: pack.id }),
                          )
                        }
                      >
                        {paused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                      {task?.foreground && (
                        <button
                          type="button"
                          className="weq-set-btn weq-set-btn-soft"
                          title="后台进行"
                          aria-label={`${pack.name}后台进行`}
                          disabled={background.isLoading}
                          onClick={() =>
                            void act(() => background.mutateAsync({ id: pack.id, taskId: task.id }))
                          }
                        >
                          <ListTodo size={14} />
                        </button>
                      )}
                    </div>
                    {operation?.total ? (
                      <span className="weq-enhancement-phase" title={operation?.source}>
                        {status}
                        {operation?.source ? ` · ${operation.source}` : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {(!pack.busy && !waiting && status) || checkedAt ? (
                  <div className="weq-enhancement-status" title={missing}>
                    {!pack.busy && !waiting && status ? <span role="status">{status}</span> : null}
                    {checkedAt ? (
                      <>
                        {!pack.busy && !waiting && status ? ' · ' : null}
                        上次成功检查：
                        <TimeLabel value={checkedAt} />
                      </>
                    ) : null}
                  </div>
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
                    ) : operation?.phase === 'failed' || task?.status === 'failed' ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="weq-enhancement-retry weq-retry-button"
                          disabled={prepare.isLoading || Boolean(pack.blocker)}
                          onClick={() => void act(() => preparePack(pack.id))}
                        >
                          <RefreshCw size={14} aria-hidden />
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
