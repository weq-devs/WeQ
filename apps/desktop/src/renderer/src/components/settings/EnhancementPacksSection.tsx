import { useContext, useState } from 'react';
import { TaskProgressBar } from '../tasks/TaskProgressBar';
import { timeDate } from '@weq/time';
import {
  AudioLines,
  BrainCircuit,
  CircleArrowUp,
  ClockArrowDown,
  Download,
  Package,
  Palette,
  RefreshCw,
  ScanText,
  Trash2,
  Pause,
  Play,
  Settings2,
  Sticker,
  Wrench,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { useReadUpdateBanner } from '../../hooks/useReadUpdateBanner';
import { useAppDialog } from '../../lib/dialogUtils';
import type { EnhancementPackId } from '../../../../shared/enhancement_manifest';
import { canPrepareEnhancement } from '../../../../shared/enhancement_actions';
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
const BATCH_ACTIONS = [
  { mode: 'download', label: '全部下载', icon: Download },
  { mode: 'update', label: '全部更新', icon: CircleArrowUp },
] as const;

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
  useReadUpdateBanner('enhancement-updates', active && Boolean(query.data));
  const [error, setError] = useState<string | null>(null);
  const prepare = trpc.bootstrap.prepareEnhancementPacks.useMutation();
  const remove = trpc.bootstrap.deleteEnhancementPack.useMutation();
  const settings = trpc.bootstrap.setEnhancementUpdates.useMutation();
  const pause = trpc.bootstrap.pauseEnhancementPack.useMutation();
  const resume = trpc.bootstrap.resumeEnhancementPack.useMutation();
  const packs = query.data?.packs ?? [];
  const autoCheck = query.data?.preferences.autoCheck ?? true;
  const checkable = packs.filter(
    (pack) =>
      pack.check?.phase === 'waiting-network' ||
      (pack.check?.phase !== 'checking' &&
        !(check.isLoading && check.variables?.ids.includes(pack.id))),
  );
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
  const preparePack = (id: EnhancementPackId) => prepare.mutateAsync({ ids: [id] });
  async function erase(id: EnhancementPackId) {
    const pack = packs.find((entry) => entry.id === id)!;
    const cancelling = pack.busy || pack.downloadTask?.status === 'paused';
    const confirmed = await dialog.confirm(
      `删除${pack.name}？`,
      `${cancelling ? '将停止本次下载或更新。' : ''}将移除 ${enhancementBytes(pack.deleteBytes)} 本地资源，下次使用需重新下载。功能设置、已有识别与分析结果、具体装扮素材，以及其他能力使用的共享资源会保留。`,
      { danger: 'outline', okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (confirmed) await act(() => remove.mutateAsync({ id }));
  }
  return (
    <div className="weq-set">
      <SectionHeader title="增强包" page="enhancement-packs" />
      <Card
        title="增强包更新设置"
        icon={<Settings2 size={15} />}
        settingId="enhancement-updates"
        resetId="enhancement-updates"
      >
        <Row
          settingId="enhancement-auto-check"
          control={
            <Toggle
              label="自动检查增强包更新"
              checked={autoCheck}
              disabled={!query.data || settings.isLoading}
              onChange={(autoCheck) => void act(() => settings.mutateAsync({ autoCheck }))}
            />
          }
        />
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
      <Card
        title="增强包管理"
        icon={<Package size={15} />}
        settingId="enhancement-management"
        action={
          <div className="weq-enhancement-batch-actions">
            {BATCH_ACTIONS.map(({ mode, label, icon: BatchIcon }) => {
              const ids = packs
                .filter((pack) =>
                  canPrepareEnhancement(pack, mode, pack.downloadTask?.status === 'paused'),
                )
                .map(({ id }) => id);
              return ids.length ? (
                <button
                  type="button"
                  key={mode}
                  className="weq-set-btn"
                  disabled={prepare.isLoading}
                  onClick={() => void act(() => prepare.mutateAsync({ ids, mode }))}
                >
                  <BatchIcon size={14} aria-hidden />
                  {label}
                </button>
              ) : null;
            })}
            {checkable.length ? (
              <button
                type="button"
                className="weq-set-btn"
                onClick={() =>
                  void act(() => check.mutateAsync({ ids: checkable.map(({ id }) => id) }))
                }
              >
                <RefreshCw size={14} aria-hidden />
                全部检查
              </button>
            ) : null}
          </div>
        }
      >
        <ul className="weq-enhancement-list">
          {packs.map((pack) => {
            const Icon = ICONS[pack.id];
            const operation = pack.operation;
            const task = pack.downloadTask;
            const waiting = !pack.busy && task?.status === 'paused';
            const paused = operation?.paused || waiting;
            const canPause =
              pack.busy && operation?.phase !== 'removing' && operation?.phase !== 'installing';
            const checking =
              pack.check?.phase === 'checking' ||
              (check.isLoading && check.variables?.ids.includes(pack.id));
            const checkedAt = timeDate(pack.check?.checkedAt);
            const updatedAt = timeDate(pack.updatedAt);
            const installedAt = timeDate(pack.installedAt);
            const checked = pack.check?.phase === 'checked';
            const checkingStatus =
              pack.check?.phase === 'waiting-network'
                ? '等待网络允许检查'
                : checking
                  ? '正在检查更新'
                  : null;
            const availableStatus = pack.needsRepair
              ? '待补齐'
              : checked && pack.updateAvailable
                ? '有新版本'
                : checked && !pack.blocker && !pack.installed
                  ? '可下载'
                  : null;
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
                : (checkingStatus ??
                  availableStatus ??
                  (checked && !pack.blocker ? '已是最新' : null));
            const issue =
              pack.blocker ??
              operation?.error ??
              (task?.status === 'failed' ? task.note : undefined) ??
              pack.check?.error;
            const missing = pack.missingComponents?.length
              ? `缺少或损坏：${pack.missingComponents.join('、')}`
              : undefined;
            const prepareLabel = pack.needsRepair
              ? '补齐'
              : !pack.downloaded
                ? '下载'
                : pack.updateAvailable
                  ? '更新'
                  : null;
            const primaryLabel = waiting || canPause ? (paused ? '继续' : '暂停') : prepareLabel;
            const PrimaryIcon = {
              下载: Download,
              更新: CircleArrowUp,
              补齐: Wrench,
              继续: Play,
              暂停: Pause,
            }[primaryLabel ?? '下载'];
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
                  <span className="weq-enhancement-name">
                    {pack.name}
                    <span
                      className="weq-enhancement-size weq-number"
                      title={`完整包下载大小\n本地占用 ${enhancementBytes(pack.sizeOnDisk)}${pack.sharedBytes ? `，含 ${enhancementBytes(pack.sharedBytes)} 共享资源` : ''}`}
                    >
                      {pack.fullDownloadBytes == null
                        ? '（大小未知）'
                        : `（${enhancementBytes(pack.fullDownloadBytes)}）`}
                    </span>
                  </span>
                  <span className="weq-enhancement-description">{pack.description}</span>
                </div>
                <div
                  className="weq-enhancement-actions"
                  role="group"
                  aria-label={`${pack.name}操作`}
                >
                  {primaryLabel && (!pack.busy || canPause) ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      title={
                        waiting || canPause
                          ? `${primaryLabel}${pack.name}`
                          : `${primaryLabel}${pack.name} · ${enhancementBytes(pack.downloadBytes)}${missing ? `\n${missing}` : ''}`
                      }
                      aria-label={`${primaryLabel}${pack.name}`}
                      disabled={Boolean(pack.blocker && !canPause)}
                      onClick={() =>
                        void act(() =>
                          !canPause
                            ? preparePack(pack.id)
                            : paused
                              ? resume.mutateAsync({ id: pack.id })
                              : pause.mutateAsync({ id: pack.id }),
                        )
                      }
                    >
                      <PrimaryIcon size={14} aria-hidden />
                    </button>
                  ) : null}
                  {pack.installed ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-enhancement-auto-update"
                      title="自动安装更新"
                      aria-label={`${pack.name}自动安装更新`}
                      aria-pressed={pack.autoUpdate}
                      disabled={settings.isLoading}
                      onClick={() =>
                        void act(() =>
                          settings.mutateAsync({
                            pack: { id: pack.id, enabled: !pack.autoUpdate },
                          }),
                        )
                      }
                    >
                      <ClockArrowDown size={14} aria-hidden />
                    </button>
                  ) : null}
                  {pack.busy || waiting || pack.installed || pack.deleteBytes > 0 ? (
                    <button
                      data-danger="outline"
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      title={`删除${pack.name}`}
                      aria-label={`删除${pack.name}`}
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
                    {operation?.total ? (
                      <span className="weq-enhancement-phase" title={operation?.source}>
                        {status}
                        {operation?.source ? ` · ${operation.source}` : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {(!pack.busy && !waiting && status) || checkedAt || pack.installed ? (
                  <div className="weq-enhancement-status" title={missing}>
                    {!pack.busy && !waiting && status ? (
                      <span
                        role="status"
                        className={
                          !checkingStatus && availableStatus ? 'weq-set-status-accent' : undefined
                        }
                      >
                        {status}
                      </span>
                    ) : null}
                    {updatedAt ? (
                      <span>
                        上次更新 <TimeLabel value={updatedAt} />
                      </span>
                    ) : pack.installed ? (
                      <span>
                        安装时间 {installedAt ? <TimeLabel value={installedAt} /> : '未记录'}
                      </span>
                    ) : null}
                    {checkedAt ? (
                      <span>
                        上次成功检查 <TimeLabel value={checkedAt} />
                      </span>
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
                    ) : !pack.busy &&
                      (operation?.phase === 'failed' || task?.status === 'failed') ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="weq-enhancement-retry weq-retry-button"
                          disabled={Boolean(pack.blocker)}
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
