/**
 * 设置 → 全局设置.
 *
 * App-wide, account-independent items: WeQ 版本信息 + 现有配置账号列表 +
 * 默认进入账号选择 + 缓存目录（可自定义）.
 *
 * Data sources:
 *   - `bootstrap.getVersionInfo`      — WeQ / Electron / Chrome / Node versions
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
  FolderOpen,
  HardDrive,
  Info,
  Loader2,
  LockKeyhole,
  Minimize2,
  RotateCcw,
  Trash2,
  User,
} from 'lucide-react';
import type { WindowCloseBehavior } from '@weq/service';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { QqAvatar } from '../QqAvatar';
import { Card, Row, SectionHeader } from './controls';
import { UpdateCard } from './UpdateCard';
import logoUrl from '@resources/brand/logo.png';

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

/** 空闲自动锁定时长选项。0 = 关闭（仍可手动上锁）。 */
const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '关闭' },
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 30, label: '30 分钟' },
];

/** 点击关闭按钮（标题栏 ✕）时的行为。 */
const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: WindowCloseBehavior; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'tray', label: '最小化到托盘' },
  { value: 'quit', label: '直接退出' },
];

export function GlobalSettingsSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const pushToast = useToast((s) => s.push);
  const [systemAuthStatus, setSystemAuthStatus] = useState<Awaited<
    ReturnType<typeof window.weq.systemAuth.getStatus>
  > | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);
  const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior>('ask');

  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const accounts = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const autoEnter = trpc.bootstrap.getAutoEnter.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const cacheDir = trpc.bootstrap.getCacheDir.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setAutoEnter = trpc.bootstrap.setAutoEnter.useMutation();
  const clearAutoEnter = trpc.bootstrap.clearAutoEnter.useMutation();
  const pickCache = trpc.bootstrap.pickCacheDir.useMutation();
  const clearCache = trpc.bootstrap.clearCacheDir.useMutation();
  const setAutoLock = trpc.bootstrap.setAutoLockMinutes.useMutation();
  const setWindowClose = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const cacheBusy = pickCache.isLoading || clearCache.isLoading;

  // ---- WeQ 缓存清理（头像/媒体/商城表情/语音，均可重下）----
  const cacheUsage = trpc.bootstrap.listClearableCache.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const clearWeqCache = trpc.bootstrap.clearWeqCache.useMutation();
  // Which categories are checked for cleanup. Empty set + a click on 清理 means
  // "clear everything listed"; individual checkboxes narrow it down.
  const [pickedCats, setPickedCats] = useState<Set<string>>(new Set());
  const cacheItems = cacheUsage.data ?? [];
  const totalCacheBytes = cacheItems.reduce((sum, it) => sum + it.bytes, 0);

  useEffect(() => {
    const minutes = settings.data?.autoLockMinutes;
    if (typeof minutes === 'number') setAutoLockMinutes(minutes);
  }, [settings.data?.autoLockMinutes]);

  useEffect(() => {
    const behavior = settings.data?.windowCloseBehavior;
    if (behavior) setCloseBehavior(behavior);
  }, [settings.data?.windowCloseBehavior]);

  useEffect(() => {
    void window.weq.systemAuth
      .getStatus()
      .then(setSystemAuthStatus)
      .catch(() => setSystemAuthStatus(null));
  }, []);

  async function onOpenLogDir(): Promise<void> {
    try {
      await window.weq.openLogDir();
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

  function toggleCat(id: string): void {
    setPickedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onClearWeqCache(): Promise<void> {
    const ids = [...pickedCats];
    // Nothing selected → clear all listed categories.
    const targets = ids.length > 0 ? cacheItems.filter((c) => pickedCats.has(c.id)) : cacheItems;
    const willFree = targets.reduce((sum, it) => sum + it.bytes, 0);
    const label =
      ids.length > 0 ? targets.map((t) => t.label).join('、') : '全部可清理缓存';
    const ok = await confirm(
      '清理 WeQ 缓存',
      `将删除「${label}」，预计释放约 ${formatBytes(willFree)}。这些缓存会在下次需要时自动重新下载，不影响聊天记录。是否继续？`,
      { okLabel: '清理', cancelLabel: '取消', tone: 'warning' },
    );
    if (!ok) return;
    try {
      const res = await clearWeqCache.mutateAsync(ids.length > 0 ? { ids } : undefined);
      await cacheUsage.refetch();
      setPickedCats(new Set());
      pushToast({
        tone: 'success',
        title: '缓存已清理',
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

  async function onSetAutoLock(minutes: number): Promise<void> {
    if (minutes > 0 && !systemAuthStatus?.available) {
      showError('无法开启自动锁定', systemAuthStatus?.error ?? '当前设备的系统认证不可用。');
      return;
    }
    const prev = autoLockMinutes;
    setAutoLockMinutes(minutes);
    try {
      await setAutoLock.mutateAsync({ minutes });
      await settings.refetch();
    } catch (e) {
      setAutoLockMinutes(prev);
      await settings.refetch();
      showError('保存自动锁定设置失败', errMsg(e));
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

  const v = version.data;
  const accountList = accounts.data ?? [];
  const autoEnterTarget = autoEnter.data;

  return (
    <div className="weq-set">
      <SectionHeader title="全局设置" desc="与账号无关的应用级设置。" />

      {/* Version */}
      <Card>
        <div className="weq-set-hero">
          <img src={logoUrl} alt="" width={52} height={52} className="weq-set-hero-logo" />
          <div className="weq-set-hero-info">
            <span className="weq-set-hero-name">WeQ</span>
            <span className="weq-set-hero-sub weq-number">
              版本 {v?.app ?? (version.isLoading ? '…' : '未知')}
            </span>
            {v ? (
              <span className="weq-set-hero-sig">
                Electron {v.electron} · Chrome {v.chrome} · Node {v.node}
              </span>
            ) : null}
          </div>
        </div>
        <p className="weq-set-note">
          <Info size={12} strokeWidth={1.9} aria-hidden /> WeQ 完全自主解密解析 QQ
          本地数据库读取聊天记录
        </p>
      </Card>

      {/* Software update */}
      <UpdateCard />

      <Card title="应用锁">
        <Row
          label={
            <span className="weq-set-row-icon">
              <LockKeyhole size={15} strokeWidth={1.8} aria-hidden />
              空闲自动锁定
            </span>
          }
          desc={
            systemAuthStatus?.available
              ? `无操作超过所选时长后自动锁定，需用 ${systemAuthStatus.displayName} 验证才能解锁。随时可在左栏头像上方手动上锁。`
              : systemAuthStatus?.error ?? '当前设备或系统环境暂不可用，自动锁定不可开启。'
          }
          control={
            <div
              className="weq-set-seg"
              role="radiogroup"
              aria-label="空闲自动锁定时长"
            >
              {AUTO_LOCK_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={autoLockMinutes === opt.value}
                  className={`weq-set-seg-item${autoLockMinutes === opt.value ? ' is-on' : ''}`}
                  disabled={
                    settings.isLoading ||
                    setAutoLock.isLoading ||
                    (opt.value > 0 && !systemAuthStatus?.available)
                  }
                  onClick={() => void onSetAutoLock(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          }
        />
      </Card>

      {/* Window close behavior */}
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

      {/* Account list */}
      <Card title="现有配置">
        {accountList.length === 0 ? (
          <div className="weq-set-empty">
            {accounts.isLoading ? '加载中…' : '暂无保存的账号配置'}
          </div>
        ) : (
          <div className="weq-set-accounts">
            {accountList.map((acc) => {
              const isAutoEnter = autoEnterTarget?.configId === acc.configId;
              return (
                <div key={acc.configId} className="weq-set-account-item">
                  <QqAvatar uin={acc.uin} size={40} className="weq-set-account-avatar" />
                  <div className="weq-set-account-info">
                    <span className="weq-set-account-name">
                      {acc.displayName || acc.uin}
                      {isAutoEnter ? (
                        <span className="weq-set-badge weq-set-badge-ok">默认进入</span>
                      ) : null}
                    </span>
                    <span className="weq-set-account-uin weq-number">QQ {acc.uin}</span>
                    {acc.dataDir ? (
                      <span className="weq-set-account-dir" title={acc.dataDir}>
                        {acc.dataDir}
                      </span>
                    ) : null}
                  </div>
                  {!isAutoEnter ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                      onClick={() => void onSetAutoEnter(acc.uin, acc.dataDir)}
                      disabled={setAutoEnter.isLoading}
                    >
                      <User size={12} strokeWidth={1.8} aria-hidden />
                      设为默认
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="weq-set-note">
          已保存的账号配置，点击「设为默认」后下次打开 WeQ 将自动进入该账号。
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

      {/* Clear WeQ cache */}
      <Card title="清理缓存">
        <p className="weq-set-note">
          <Info size={12} strokeWidth={1.9} aria-hidden /> 以下缓存均可在需要时自动重新下载，
          删除不影响聊天记录、克隆体数据与导出产物。默认清理全部，也可勾选后单独清理。
        </p>
        <div className="weq-set-cache-list">
          {cacheUsage.isLoading ? (
            <div className="weq-set-empty">读取缓存占用中…</div>
          ) : cacheItems.length === 0 ? (
            <div className="weq-set-empty">暂无可清理的缓存</div>
          ) : (
            cacheItems.map((item) => (
              <label key={item.id} className="weq-set-cache-item">
                <input
                  type="checkbox"
                  checked={pickedCats.has(item.id)}
                  onChange={() => toggleCat(item.id)}
                  disabled={clearWeqCache.isLoading}
                />
                <HardDrive size={14} strokeWidth={1.8} aria-hidden />
                <span className="weq-set-cache-label">{item.label}</span>
                <span className="weq-set-cache-size weq-number">{formatBytes(item.bytes)}</span>
              </label>
            ))
          )}
        </div>
        <div className="weq-set-actions">
          <span className="weq-set-cache-total">
            合计占用 <strong className="weq-number">{formatBytes(totalCacheBytes)}</strong>
          </span>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-danger"
            disabled={clearWeqCache.isLoading || cacheItems.length === 0 || totalCacheBytes === 0}
            onClick={() => void onClearWeqCache()}
          >
            {clearWeqCache.isLoading ? (
              <Loader2 size={14} strokeWidth={1.8} className="weq-spin" aria-hidden />
            ) : (
              <Trash2 size={14} strokeWidth={1.8} aria-hidden />
            )}
            {pickedCats.size > 0 ? '清理所选' : '清理全部'}
          </button>
        </div>
      </Card>

      <Card title="日志">
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
      </Card>
    </div>
  );
}
