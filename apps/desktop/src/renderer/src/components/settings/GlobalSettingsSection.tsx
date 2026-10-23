/**
 * 设置 → 全局设置.
 *
 * App-wide, account-independent items: 现有配置账号列表 + 默认进入账号选择 +
 * 缓存目录（可自定义）. 版本信息与软件更新搬到了「版本」页（VersionSection）。
 *
 * Data sources:
 *   - `bootstrap.listAccountConfigs`  — saved account configs
 *   - `bootstrap.getAutoEnter`        — auto-enter target
 *   - `bootstrap.getCacheDir`         — effective / override / default cache paths
 *
 * Queries here use `staleTime: 0` + `refetchOnMount: 'always'` so reopening the
 * dialog always shows fresh state (the global QueryClient otherwise keeps
 * everything fresh for 5 min and never refetches on mount).
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Cloud,
  ChevronRight,
  FolderOpen,
  HardDrive,
  Loader2,
  Minimize2,
  RotateCcw,
  Settings2,
  Trash2,
  User,
} from 'lucide-react';
import type { WindowCloseBehavior } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { useViewState } from '../../state/view';
import { QqAvatar } from '../QqAvatar';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { ToastSettingsCard } from './ToastSettingsCard';
import { TypingStatusSettingsCard } from './TypingStatusSettingsCard';
import { DesktopOnly, IS_WEB } from '../../lib/target';
import { groupRetainedStorage } from '../../lib/storage-groups';
import '../../styles/save-preferences.css';
import '../../styles/storage-management.css';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Human-readable byte size for the cache-cleanup card. */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** 点击关闭按钮（标题栏 ✕）时的行为。 */
const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: WindowCloseBehavior; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'tray', label: '最小化到托盘' },
  { value: 'quit', label: '直接退出' },
];

/** 日志保留时长档位（0 = 永久保留）。日志按天拆文件，所以档位用「天」最直观。 */
const LOG_RETENTION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: '1 天' },
  { value: 3, label: '3 天' },
  { value: 7, label: '7 天（默认）' },
  { value: 14, label: '14 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 0, label: '永久保留' },
];

export function GlobalSettingsSection({
  section = 'general',
}: {
  section?: 'general' | 'accounts' | 'storage' | 'saving' | 'logs';
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const pushToast = useToast((s) => s.push);
  // 用来把「当前已登录的账号」标出来并禁掉它的删除按钮。
  const openedUin = useViewState((s) => s.openedUin);
  const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior>('ask');
  const [preferCdn, setPreferCdn] = useState(false);
  const [logRetentionDays, setLogRetentionDays] = useState(7);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const accounts = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  // 「当前账号」要按 configId 认：同一个 QQ 号可能同时有在线账号和静态账号，
  // 只比 uin 会给两条记录都打上「当前账号」。
  const currentConfig = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const autoEnter = trpc.bootstrap.getAutoEnter.useQuery(undefined, {
    enabled: section === 'accounts',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const cacheDir = trpc.bootstrap.getCacheDir.useQuery(undefined, {
    enabled: section === 'storage',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setAutoEnter = trpc.bootstrap.setAutoEnter.useMutation();
  const clearAutoEnter = trpc.bootstrap.clearAutoEnter.useMutation();
  const deleteAccount = trpc.bootstrap.deleteAccountConfig.useMutation();
  const pickCache = trpc.bootstrap.pickCacheDir.useMutation();
  const clearCache = trpc.bootstrap.clearCacheDir.useMutation();
  const pickExportDir = trpc.bootstrap.pickDefaultExportDir.useMutation();
  const setExportDir = trpc.bootstrap.setDefaultExportDir.useMutation();
  const setExportMode = trpc.bootstrap.setExportSaveMode.useMutation();
  const setWindowClose = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const setPreferCdnMut = trpc.bootstrap.setPreferCdn.useMutation();
  const setLogRetention = trpc.bootstrap.setLogRetentionDays.useMutation();
  const cacheBusy = pickCache.isLoading || clearCache.isLoading;

  // 存储统计包含持久数据，选择与清理只针对后端明确标记的可清理项。
  const cacheUsage = trpc.bootstrap.listStorageUsage.useQuery(undefined, {
    enabled: section === 'storage',
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const clearWeqCache = trpc.bootstrap.clearWeqCache.useMutation();
  const clearStorageData = trpc.bootstrap.clearStorageData.useMutation();
  const cleanupResult = trpc.bootstrap.storageCleanupResult.useQuery(undefined, {
    enabled: section === 'storage',
  });
  const cleanupBusy = clearWeqCache.isLoading || clearStorageData.isLoading;
  const [pickedCats, setPickedCats] = useState<Set<string>>(new Set());
  const cacheItems = cacheUsage.data ?? [];
  const clearableItems = cacheItems.filter(
    (item) => item.clearable && (item.bytes > 0 || item.incomplete),
  );
  const retainedGroups = groupRetainedStorage(cacheItems);
  const safeCacheItems = clearableItems.filter((item) => !item.requiresExit);
  const riskGroups = groupRetainedStorage(
    clearableItems
      .filter((item) => item.requiresExit)
      .map((item) => ({ ...item, clearable: false })),
  );
  const totalCacheBytes = cacheItems.reduce((sum, it) => sum + it.bytes, 0);
  const clearableBytes = clearableItems.reduce((sum, it) => sum + it.bytes, 0);
  const selectedItems = clearableItems.filter((item) => pickedCats.has(item.id));
  const cleanupBytes = (pickedCats.size > 0 ? selectedItems : safeCacheItems).reduce(
    (sum, item) => sum + item.bytes,
    0,
  );

  useEffect(() => {
    const behavior = settings.data?.windowCloseBehavior;
    if (behavior) setCloseBehavior(behavior);
  }, [settings.data?.windowCloseBehavior]);

  useEffect(() => {
    const enabled = settings.data?.preferCdn;
    if (typeof enabled === 'boolean') setPreferCdn(enabled);
  }, [settings.data?.preferCdn]);

  useEffect(() => {
    const days = settings.data?.logRetentionDays;
    if (typeof days === 'number') setLogRetentionDays(days);
  }, [settings.data?.logRetentionDays]);

  async function onOpenLogDir(): Promise<void> {
    try {
      await window.weq.openLogDir();
      pushToast({
        tone: 'success',
        title: '已打开日志文件夹',
        detail: '日志按日期拆分保存，反馈问题时可将最新日志一并附上。',
      });
    } catch (e) {
      showError('打开日志文件夹失败', errMsg(e));
    }
  }

  async function onPickCache(): Promise<void> {
    try {
      await pickCache.mutateAsync();
      await cacheDir.refetch();
      pushToast({ tone: 'success', title: '缓存目录已更新', message: '下次进入账号生效' });
    } catch (e) {
      showError('选择缓存目录失败', errMsg(e));
    }
  }

  async function onResetCache(): Promise<void> {
    try {
      await clearCache.mutateAsync();
      await cacheDir.refetch();
      pushToast({ tone: 'success', title: '已重置为默认缓存目录' });
    } catch (e) {
      showError('重置缓存目录失败', errMsg(e));
    }
  }

  async function onPickExportDir(): Promise<void> {
    try {
      const picked = await pickExportDir.mutateAsync();
      if (picked) {
        await settings.refetch();
        pushToast({ tone: 'success', title: '导出保存目录已更新' });
      }
    } catch (e) {
      showError('选择导出保存目录失败', errMsg(e));
    }
  }

  async function onChangeExportMode(mode: 'before' | 'preset' | 'after'): Promise<void> {
    try {
      if (mode === 'preset' && !settings.data?.defaultExportDir) {
        const picked = await pickExportDir.mutateAsync();
        if (!picked) return;
      }
      await setExportMode.mutateAsync({ mode });
      await settings.refetch();
    } catch (error) {
      showError('更新保存方式失败', errMsg(error));
    }
  }

  async function onResetExportDir(): Promise<void> {
    try {
      await setExportDir.mutateAsync({ dir: null });
      await settings.refetch();
      pushToast({ tone: 'success', title: '已清除默认导出保存目录' });
    } catch (e) {
      showError('清除导出保存目录失败', errMsg(e));
    }
  }

  const cacheMulti = useMultiSelection({
    ids: clearableItems.map((item) => item.id),
    selected: pickedCats,
    onChange: setPickedCats,
    disabled: cleanupBusy || cacheUsage.isFetching,
  });

  const storageItem = (item: (typeof cacheItems)[number]) => (
    <label key={item.id} className="weq-set-cache-item" {...cacheMulti.itemProps(item.id)}>
      <input
        type="checkbox"
        aria-label={item.label}
        checked={pickedCats.has(item.id)}
        readOnly
        disabled={cleanupBusy || cacheUsage.isFetching}
      />
      <HardDrive size={14} strokeWidth={1.8} aria-hidden />
      <span className="weq-storage-detail">
        <span>{item.label}</span>
        <small>{item.confirmation ?? item.reason}</small>
        <small className="weq-storage-path">{item.path}</small>
      </span>
      <span className="weq-set-cache-size weq-number">{formatBytes(item.bytes)}</span>
    </label>
  );

  async function onClearWeqCache(): Promise<void> {
    const targets = pickedCats.size > 0 ? selectedItems : safeCacheItems;
    const ids = targets.map((item) => item.id);
    if (ids.length === 0) return;
    const willFree = targets.reduce((sum, it) => sum + it.bytes, 0);
    const label = pickedCats.size > 0 ? targets.map((t) => t.label).join('、') : '全部可清理缓存';
    const exit = targets.some((item) => item.requiresExit);
    const extra = targets.flatMap((item) =>
      item.confirmation ? [`${item.label}：${item.confirmation}`] : [],
    );
    const ok = await confirm(
      exit ? '退出并清除所选数据' : '清理 WeQ 缓存',
      exit
        ? `将完全退出 WeQ，然后永久删除「${label}」，预计清除约 ${formatBytes(willFree)}。只删除所选路径中的数据，不会额外清理其它 QQ 数据目录。请先停止导出、模型下载和数据库修复，并退出托管 QQ。\n\n${extra.join('\n\n')}\n\n清除期间不要重新启动应用；下次打开存储管理可查看结果。确认接受这些风险并退出？`
        : `将删除「${label}」，预计释放约 ${formatBytes(willFree)}。需要时会重新下载或生成；保留数据不受影响。${extra.length ? `\n\n${extra.join('\n')}\n\n` : ''}是否继续？`,
      { okLabel: exit ? '退出并清除' : '清理', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      if (exit) {
        await clearStorageData.mutateAsync({ ids, acknowledgeRisk: true });
        pushToast({
          tone: 'warning',
          title: '已安排退出后清除',
          message: '等待清除完成后再打开 WeQ；清除结果会保留。',
        });
        return;
      }
      const res = await clearWeqCache.mutateAsync({ ids });
      await cacheUsage.refetch();
      setPickedCats(new Set());
      pushToast({
        tone: res.failed.length > 0 ? 'warning' : 'success',
        title: res.failed.length > 0 ? '部分缓存未能清理' : '缓存已清理',
        message: `释放约 ${formatBytes(res.freedBytes)}`,
      });
    } catch (e) {
      showError('清理缓存失败', errMsg(e));
    }
  }

  async function onSetAutoEnter(uin: string, dataDir?: string): Promise<void> {
    try {
      await setAutoEnter.mutateAsync({ uin, dataDir });
      await autoEnter.refetch();
    } catch (e) {
      showError('设置默认进入账号失败', errMsg(e));
    }
  }

  async function onClearAutoEnter(): Promise<void> {
    try {
      await clearAutoEnter.mutateAsync();
      await autoEnter.refetch();
    } catch (e) {
      showError('清除默认进入账号失败', errMsg(e));
    }
  }

  // 删除账号配置。和 bootstrap 选择页 / 左栏底部弹层走同一个后端接口，
  // 删的只是 WeQ 侧保存的配置（密钥、数据目录、昵称快照），不动 QQ 本体数据。
  // 当前已登录的账号不给删——删掉配置后界面还挂在这个账号上，状态会自相矛盾。
  async function onDeleteAccount(acc: {
    configId: string;
    uin: string;
    displayName?: string;
  }): Promise<void> {
    const label = acc.displayName || acc.uin;
    const ok = await confirm(
      '删除账号配置',
      `将删除「${label}」在 WeQ 中保存的配置（数据库密钥、数据目录等），下次需要重新获取密钥。QQ 本体的聊天记录不受影响。是否继续？`,
      { okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      await deleteAccount.mutateAsync({ configId: acc.configId });
      await Promise.all([accounts.refetch(), autoEnter.refetch()]);
      pushToast({ tone: 'success', title: '已删除', message: `账号配置「${label}」已移除` });
    } catch (e) {
      showError('删除账号配置失败', errMsg(e));
    }
  }

  async function onSetCloseBehavior(behavior: WindowCloseBehavior): Promise<void> {
    const prev = closeBehavior;
    setCloseBehavior(behavior);
    try {
      await setWindowClose.mutateAsync({ behavior });
      await settings.refetch();
    } catch (e) {
      setCloseBehavior(prev);
      await settings.refetch();
      showError('保存关闭行为设置失败', errMsg(e));
    }
  }

  async function onSetPreferCdn(next: boolean): Promise<void> {
    const prev = preferCdn;
    setPreferCdn(next);
    try {
      await setPreferCdnMut.mutateAsync({ enabled: next });
      await settings.refetch();
    } catch (e) {
      setPreferCdn(prev);
      await settings.refetch();
      showError('保存 CDN 设置失败', errMsg(e));
    }
  }

  // 保存后主进程会立即按新阈值清一轮，所以这里只是"回读一次真实值 + 失败回滚"。
  async function onSetLogRetention(days: number): Promise<void> {
    const prev = logRetentionDays;
    setLogRetentionDays(days);
    try {
      await setLogRetention.mutateAsync({ days });
      await settings.refetch();
    } catch (e) {
      setLogRetentionDays(prev);
      await settings.refetch();
      showError('保存日志保留时长失败', errMsg(e));
    }
  }

  const accountList = accounts.data ?? [];
  const autoEnterTarget = autoEnter.data;

  return (
    <div className={`weq-set${section === 'storage' ? ' weq-storage-settings' : ''}`}>
      <SectionHeader
        icon={<Settings2 size={16} strokeWidth={1.8} />}
        title={
          {
            general: '窗口行为',
            accounts: '账号管理',
            storage: '存储与网络',
            saving: '默认保存',
            logs: '日志',
          }[section]
        }
      />

      {/* Window close behavior */}
      {section === 'general' && (
        <>
          <ToastSettingsCard />
          <TypingStatusSettingsCard />
          <DesktopOnly>
            <Card title="窗口">
              <Row
                label={
                  <span className="weq-set-row-icon">
                    <Minimize2 size={15} strokeWidth={1.8} aria-hidden />
                    关闭按钮
                  </span>
                }
                desc={
                  closeBehavior === 'tray'
                    ? '点击关闭按钮后最小化到系统托盘，进程常驻后台，可从托盘图标恢复。'
                    : closeBehavior === 'quit'
                      ? '点击关闭按钮后直接完全退出应用。'
                      : '每次点击关闭按钮时弹窗询问，可选择最小化到托盘或完全退出。'
                }
                control={
                  <div className="weq-set-seg" role="radiogroup" aria-label="关闭按钮行为">
                    {CLOSE_BEHAVIOR_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={closeBehavior === opt.value}
                        className={`weq-set-seg-item${closeBehavior === opt.value ? ' is-on' : ''}`}
                        disabled={settings.isLoading || setWindowClose.isLoading}
                        onClick={() => void onSetCloseBehavior(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                }
              />
            </Card>
          </DesktopOnly>
          {IS_WEB ? (
            <p className="weq-set-note" role="status">
              浏览器模式下，窗口关闭行为由浏览器管理。
            </p>
          ) : null}
        </>
      )}

      {/* Account list */}
      {section === 'accounts' && (
        <Card title="现有配置">
          {accountList.length === 0 ? (
            <div className="weq-set-empty">
              {accounts.isLoading ? '加载中…' : '暂无保存的账号配置'}
            </div>
          ) : (
            <div className="weq-set-accounts">
              {accountList.map((acc) => {
                const isAutoEnter = autoEnterTarget?.configId === acc.configId;
                const currentConfigId = currentConfig.data?.configId ?? null;
                const isCurrent = currentConfigId
                  ? acc.configId === currentConfigId
                  : !!openedUin && acc.uin === openedUin;
                return (
                  <div key={acc.configId} className="weq-set-account-item">
                    <QqAvatar uin={acc.uin} size={40} className="weq-set-account-avatar" />
                    <div className="weq-set-account-info">
                      <span className="weq-set-account-name">
                        {acc.displayName || acc.uin}
                        {acc.static ? (
                          <span className="weq-set-badge">
                            {acc.mobile ? '手机备份' : '静态账号'}
                          </span>
                        ) : null}
                        {isAutoEnter ? (
                          <span className="weq-set-badge weq-set-badge-ok">默认进入</span>
                        ) : null}
                        {isCurrent ? (
                          <span className="weq-set-badge weq-set-badge-ok">当前账号</span>
                        ) : null}
                      </span>
                      <span className="weq-set-account-uin weq-number">QQ {acc.uin}</span>
                      {acc.dataDir ? (
                        <span className="weq-set-account-dir" title={acc.dataDir}>
                          {acc.dataDir}
                        </span>
                      ) : null}
                    </div>
                    {isAutoEnter ? (
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                        onClick={() => void onClearAutoEnter()}
                        disabled={clearAutoEnter.isLoading}
                        title="下次打开 WeQ 不再自动进入该账号"
                      >
                        <RotateCcw size={12} strokeWidth={1.8} aria-hidden />
                        取消默认进入
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                        onClick={() => void onSetAutoEnter(acc.uin, acc.dataDir)}
                        disabled={setAutoEnter.isLoading}
                      >
                        <User size={12} strokeWidth={1.8} aria-hidden />
                        设为默认
                      </button>
                    )}
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm weq-set-btn-del"
                      onClick={() => void onDeleteAccount(acc)}
                      disabled={deleteAccount.isLoading || isCurrent}
                      title={
                        isCurrent ? '当前已登录的账号无法删除，请先退出登录' : '删除该账号配置'
                      }
                    >
                      <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="weq-set-note">
            已保存的账号配置，点击「设为默认」后下次打开 WeQ 将自动进入该账号；想改回手动选择，
            对已默认的账号点击「取消默认进入」即可。「删除」只移除 WeQ 侧保存的配置，不影响 QQ
            本体数据。
          </p>
          {autoEnterTarget ? (
            <div className="weq-set-actions">
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onClearAutoEnter()}
                disabled={clearAutoEnter.isLoading}
              >
                <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                清除默认进入账号
              </button>
            </div>
          ) : null}
        </Card>
      )}

      {section === 'storage' && (
        <>
          {/* Prefer CDN */}
          <Card title="网络">
            <Row
              label={
                <span className="weq-set-row-icon">
                  <Cloud size={15} strokeWidth={1.8} aria-hidden />
                  优先使用 CDN
                </span>
              }
              desc={
                preferCdn
                  ? '头像与聊天图片、视频封面由界面直接向 QQ 服务器获取，不经 WeQ 中转。本地已存的头像和媒体缓存会被绕过（离线时看不到），获取失败会自动回退到原来的方式。'
                  : '默认由 WeQ 读取本地文件、缺失时代取并缓存——离线可用，但浏览器访问模式下所有图片都要占用服务器带宽。开启后改由界面直连，服务器零流量。语音、视频原片与文件不受影响。'
              }
              control={
                <Toggle
                  checked={preferCdn}
                  disabled={settings.isLoading || setPreferCdnMut.isLoading}
                  onChange={(next) => void onSetPreferCdn(next)}
                  label="优先使用 CDN"
                />
              }
            />
          </Card>

          {/* Cache directory */}
          <Card title="缓存目录">
            <Row
              label={
                <span className="weq-set-path" title={cacheDir.data?.effective}>
                  <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                  <span className="weq-set-path-txt">
                    {cacheDir.data?.effective ?? (cacheDir.isLoading ? '读取中…' : '—')}
                  </span>
                </span>
              }
              desc={
                cacheDir.data?.override
                  ? '已使用自定义目录。更改后将于下次进入账号时对媒体缓存生效。'
                  : '默认目录。下载的图片/视频等媒体会缓存在这里。'
              }
              control={
                <div className="weq-set-btn-group">
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={cacheBusy}
                    onClick={() => void onPickCache()}
                  >
                    <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                    选择目录
                  </button>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    disabled={cacheBusy || !cacheDir.data?.override}
                    onClick={() => void onResetCache()}
                  >
                    <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                    重置默认
                  </button>
                </div>
              }
            />
          </Card>
        </>
      )}
      {/* Default export save directory */}
      {section === 'saving' && (
        <div className="weq-save-preferences">
          <Card title="保存位置">
            <Row
              label="默认保存方式"
              control={
                <select
                  aria-label="默认导出保存方式"
                  value={settings.data?.exportSaveMode ?? 'before'}
                  disabled={
                    settings.isLoading || setExportMode.isLoading || pickExportDir.isLoading
                  }
                  onChange={(event) => {
                    const mode = event.target.value;
                    if (mode !== 'before' && mode !== 'preset' && mode !== 'after') return;
                    void onChangeExportMode(mode);
                  }}
                >
                  <option value="before">每次询问保存位置</option>
                  <option value="preset">自动保存到默认文件夹</option>
                  {settings.data?.exportSaveMode === 'after' && (
                    <option value="after">先生成，稍后保存（旧偏好）</option>
                  )}
                </select>
              }
            />
            <Row
              label={
                <span className="weq-set-path" title={settings.data?.defaultExportDir ?? ''}>
                  <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                  <span className="weq-set-path-txt">
                    {settings.data?.defaultExportDir ?? (settings.isLoading ? '读取中…' : '未设置')}
                  </span>
                </span>
              }
              desc={settings.data?.defaultExportDir ? undefined : '未设置默认文件夹'}
              control={
                <div className="weq-set-btn-group">
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={pickExportDir.isLoading}
                    onClick={() => void onPickExportDir()}
                  >
                    <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                    选择目录
                  </button>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    disabled={setExportDir.isLoading || !settings.data?.defaultExportDir}
                    onClick={() => void onResetExportDir()}
                  >
                    <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                    清除设置
                  </button>
                </div>
              }
            />
          </Card>
        </div>
      )}

      {/* WeQ 存储管理 */}
      {section === 'storage' && (
        <Card title="WeQ 存储管理">
          <div className="weq-set-actions weq-storage-toolbar">
            <span className="weq-set-cache-total">
              合计占用 <strong className="weq-number">{formatBytes(totalCacheBytes)}</strong>
              {' · '}可清理 <strong className="weq-number">{formatBytes(clearableBytes)}</strong>
              {cacheItems.some((item) => item.incomplete) ? '（统计不完整）' : ''}
            </span>
            <div className="weq-set-btn-group weq-storage-toolbar-buttons">
              <button
                type="button"
                className="weq-set-btn"
                title="刷新存储占用"
                aria-label="刷新存储占用"
                disabled={cacheUsage.isFetching || cleanupBusy}
                onClick={() => void cacheUsage.refetch()}
              >
                <RotateCcw size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-danger"
                disabled={
                  cleanupBusy || cacheUsage.isFetching || cacheUsage.isError || cleanupBytes === 0
                }
                onClick={() => void onClearWeqCache()}
              >
                {cleanupBusy ? (
                  <Loader2 size={14} strokeWidth={1.8} className="weq-spin" aria-hidden />
                ) : (
                  <Trash2 size={14} strokeWidth={1.8} aria-hidden />
                )}
                {selectedItems.some((item) => item.requiresExit)
                  ? '退出并清除所选'
                  : pickedCats.size > 0
                    ? '清理所选'
                    : '清理缓存'}
              </button>
            </div>
          </div>
          {cleanupResult.data && (
            <div
              className="weq-storage-result"
              role={cleanupResult.data.failed.length ? 'alert' : 'status'}
            >
              <span>
                上次退出后清除：{cleanupResult.data.cleared.length} 项成功，
                {cleanupResult.data.failed.length} 项失败，清除约{' '}
                {formatBytes(cleanupResult.data.freedBytes)}。
              </span>
              {cleanupResult.data.failed.map((item) => (
                <div key={item.label}>
                  {item.label}：{item.error}
                </div>
              ))}
            </div>
          )}
          <div className="weq-set-cache-list" {...cacheMulti.rootProps}>
            {cacheUsage.isLoading ? (
              <div className="weq-set-empty" role="status">
                读取存储占用中…
              </div>
            ) : cacheUsage.isError ? (
              <div className="weq-set-empty" role="alert">
                读取存储占用失败：{errMsg(cacheUsage.error)}
              </div>
            ) : clearableItems.length === 0 && retainedGroups.length === 0 ? (
              <div className="weq-set-empty">暂无存储数据</div>
            ) : (
              <>
                {safeCacheItems.length > 0 && (
                  <div className="weq-storage-group">
                    <h4>可清理缓存</h4>
                    {safeCacheItems.map(storageItem)}
                  </div>
                )}
                {riskGroups.length > 0 && (
                  <div className="weq-storage-group">
                    <h4>需确认风险的数据</h4>
                    {riskGroups.map((group) => (
                      <details className="weq-storage-category" key={group.label}>
                        <summary>
                          <ChevronRight size={14} className="weq-storage-chevron" aria-hidden />
                          <span className="weq-storage-detail">{group.label}</span>
                          <span className="weq-set-cache-size weq-number">
                            {formatBytes(group.bytes)}
                          </span>
                        </summary>
                        <div className="weq-storage-entries">{group.items.map(storageItem)}</div>
                      </details>
                    ))}
                  </div>
                )}
                {retainedGroups.length > 0 && (
                  <div className="weq-storage-group">
                    <h4>保留数据</h4>
                    {retainedGroups.map((group) => (
                      <details className="weq-storage-category" key={group.label}>
                        <summary>
                          <ChevronRight size={14} className="weq-storage-chevron" aria-hidden />
                          <span className="weq-storage-detail">{group.label}</span>
                          <span className="weq-set-cache-size weq-number">
                            {group.incomplete ? '至少 ' : ''}
                            {formatBytes(group.bytes)}
                          </span>
                        </summary>
                        <div className="weq-storage-entries">
                          {group.items.map((item) => (
                            <div key={item.id} className="weq-set-cache-item is-readonly">
                              <HardDrive size={14} strokeWidth={1.8} aria-hidden />
                              <span className="weq-storage-detail">
                                <span>{item.label}</span>
                                <small>{item.reason}</small>
                                <small className="weq-storage-path">{item.path}</small>
                              </span>
                              <span className="weq-set-cache-size weq-number">
                                {item.incomplete ? '至少 ' : ''}
                                {formatBytes(item.bytes)}
                              </span>
                            </div>
                          ))}
                          {group.items.length === 0 && (
                            <div className="weq-set-empty">系统辅助文件</div>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      )}

      {section === 'logs' && (
        <Card title="日志">
          <Row
            label="日志保留时长"
            desc={
              logRetentionDays > 0
                ? `超过 ${logRetentionDays} 天的日志会在启动时与后台自动清理，日志文件夹不会一直变大。正在写入的当天日志永远保留。`
                : '永久保留全部日志，不自动清理。日志文件夹会随着使用持续变大。'
            }
            control={
              <select
                className="weq-set-input"
                value={String(logRetentionDays)}
                disabled={settings.isLoading || setLogRetention.isLoading}
                onChange={(e) => void onSetLogRetention(Number(e.target.value))}
                aria-label="日志保留时长"
              >
                {/* 配置里存了非档位值（旧版本 / 手改）时补一个选项，避免 select 显示为空 */}
                {logRetentionDays > 0 &&
                !LOG_RETENTION_OPTIONS.some((o) => o.value === logRetentionDays) ? (
                  <option value={String(logRetentionDays)}>{logRetentionDays} 天</option>
                ) : null}
                {LOG_RETENTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            }
          />
          <DesktopOnly>
            <Row
              label="日志文件夹"
              desc="日志按日期拆分保存到 WeQ 缓存目录下的 logs 文件夹。"
              control={
                <button type="button" className="weq-set-btn" onClick={() => void onOpenLogDir()}>
                  <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                  打开日志文件夹
                </button>
              }
            />
          </DesktopOnly>
        </Card>
      )}
    </div>
  );
}
