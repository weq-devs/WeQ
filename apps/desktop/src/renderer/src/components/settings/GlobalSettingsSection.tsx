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
import { Check, FolderOpen, Info, LockKeyhole, RotateCcw, User } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { Card, Row, SectionHeader } from './controls';
import { UpdateCard } from './UpdateCard';
import logoUrl from '@resources/brand/logo.png';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 空闲自动锁定时长选项。0 = 关闭（仍可手动上锁）。 */
const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '关闭' },
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 30, label: '30 分钟' },
];

export function GlobalSettingsSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const [systemAuthStatus, setSystemAuthStatus] = useState<Awaited<
    ReturnType<typeof window.weq.systemAuth.getStatus>
  > | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);

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
  const cacheBusy = pickCache.isLoading || clearCache.isLoading;

  useEffect(() => {
    const minutes = settings.data?.autoLockMinutes;
    if (typeof minutes === 'number') setAutoLockMinutes(minutes);
  }, [settings.data?.autoLockMinutes]);

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
    } catch (e) {
      showError('选择缓存目录失败', errMsg(e));
    }
  }

  async function onResetCache(): Promise<void> {
    try {
      await clearCache.mutateAsync();
      await cacheDir.refetch();
    } catch (e) {
      showError('重置缓存目录失败', errMsg(e));
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
