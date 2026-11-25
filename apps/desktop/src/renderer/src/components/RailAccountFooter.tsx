/**
 * 菜单底部应用控制，以及账号切换与退出弹层。
 *
 * 切换/退出都走 closeAccount → 后端 clearAccount 显式停掉
 * accountMonitor（QQ 登录实例监听）和 dbWatchHandle（数据库监听），
 * 切换时再 openAccount 重新开启。MainView 在 App.tsx 中用
 * key={openedUin} 强制重挂载，避免 onDbChanged 订阅绑到旧账号。
 *
 * 关键：切换/退出时必须用 queryClient.removeQueries 把 React Query
 * 里所有 `trpc.account.*` 的缓存条目「彻底清除」（不仅 invalidate）。
 * 否则新账号挂载 MainView 时，useQuery 会把旧账号的 listRecentContacts
 * 缓存数据当作初始值返回，导致 recent_contact 残留旧账号会话。
 * staleTime=5min + refetchOnMount=false 会把这个窗口放大到几分钟。
 */

import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { OverlayLayer } from './OverlayLayer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LockKeyhole,
  Eye,
  EyeOff,
  LogOut,
  Moon,
  Sun,
  Trash2,
  Camera,
  Database,
  Smartphone,
  RefreshCw,
  ExternalLink,
  Plus,
} from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { leaveAccountForBootstrap } from '../lib/leaveAccount';
import { switchAccount, type SwitchTarget } from '../lib/switchAccount';
import { useAppLock } from '../state/lock';
import { usePrivacyStore } from '../state/privacy';
import { useThemeStore } from '../state/theme';
import { confirmMailAccountLeave } from '../state/mailDraft';
import {
  fetchSystemAuthStatus,
  fetchTotpStatus,
  SYSTEM_AUTH_STATUS_QUERY_KEY,
  TOTP_STATUS_QUERY_KEY,
} from '../lib/appLockStatus';
import { useDialog } from './Dialog.shared';
import { useToast } from './Toast.shared';
import { LoadingIndicator } from './LoadingIndicator';
import { QqAvatar } from './QqAvatar';
import { IS_WEB, shellBridge } from '../lib/target.shared';
import { useRemoteClient } from '../lib/remoteClient';
import { accountGatewayPath, isAccountGateway, rememberRemoteAccount } from '../lib/accountGateway';
import { clearRemoteWorkspace } from '../lib/remoteWebStartup';
import '../styles/rail-account.css';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useMenuCapture } from '../hooks/useMenuCapture';
import { captureMenuScreenshot } from '../lib/menuScreenshot';
import { captureWebWindow } from '../lib/webScreenshot';
import '../styles/menu-capture.css';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function MenuCaptureButton({ onCapture }: { onCapture: () => Promise<void> }): ReactElement {
  const menuCapture = useMenuCapture(onCapture);
  return (
    <button
      type="button"
      className="weq-workspace-control weq-menu-capture-button"
      title={IS_WEB ? '截图当前界面' : '截图当前窗口（复制到剪贴板）'}
      aria-label="截图当前窗口"
      {...menuCapture}
    >
      <Camera size={18} aria-hidden />
    </button>
  );
}

export function RailAccountFooter({
  currentUin,
  currentName,
  currentAvatarUrl,
  children,
}: {
  currentUin: string;
  currentName: string;
  currentAvatarUrl?: string | null;
  children?: ReactNode | ((controls: ReactNode) => ReactNode);
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const lock = useAppLock((s) => s.lock);
  const privacyEnabled = usePrivacyStore((s) => s.enabled);
  const togglePrivacy = usePrivacyStore((s) => s.toggle);
  const remote = useRemoteClient();
  // 菜单与设置共用主题状态；快捷切换固定为浅/深色，跟随系统仍在设置里选择。
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const setThemePreference = useThemeStore((s) => s.setPreference);
  const pushToast = useToast((s) => s.push);
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const capturePending = useRef(false);

  // 应用锁配置（解锁方式 / 总开关），供上锁按钮做可上锁判断。
  const lockSettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // 验证器 / 系统认证是否可用：与设置页、锁屏遮罩共用同一查询，
  // 绑定 / 解绑后由设置页 invalidate，按钮状态即时刷新。
  const systemAuthQuery = useQuery({
    queryKey: SYSTEM_AUTH_STATUS_QUERY_KEY,
    queryFn: fetchSystemAuthStatus,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const totpQuery = useQuery({
    queryKey: TOTP_STATUS_QUERY_KEY,
    queryFn: fetchTotpStatus,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const appLock = lockSettings.data?.appLock;
  const lockMethod = appLock?.method ?? 'totp';

  /** 按钮禁用时的提示原因；null = 当前可上锁。 */
  function lockBlockReason(): string | null {
    if (IS_WEB) return '请在电脑端锁定 WeQ。';
    if (!appLock) return '应用锁设置尚未就绪。';
    if (!appLock.enabled) return '应用锁已关闭，请在 设置 → 应用 → 隐私 中开启。';
    if (lockMethod === 'system') {
      return systemAuthQuery.data?.available === false
        ? (systemAuthQuery.data?.error ?? '当前设备系统认证不可用。')
        : null;
    }
    return totpQuery.data?.configured === false
      ? '验证器未绑定，请先在 设置 → 应用 → 隐私 中完成绑定。'
      : null;
  }

  // 上锁前拉一次最新配置，避免缓存陈旧导致上锁后无法解锁。
  async function lockNow(): Promise<void> {
    if (IS_WEB) return;
    try {
      const fresh = await lockSettings.refetch();
      const cfg = fresh.data?.appLock;
      if (fresh.error || !cfg) throw new Error('应用锁设置尚未就绪。');
      if (!cfg.enabled) {
        showError('无法上锁', '应用锁已关闭，请在 设置 → 应用 → 隐私 中开启。');
        return;
      }
      const method = cfg?.method ?? 'totp';
      if (method === 'system') {
        const bridge = shellBridge();
        const status = bridge ? await bridge.systemAuth.getStatus() : null;
        if (!status?.available) {
          showError('无法上锁', status?.error ?? '当前设备系统认证不可用。');
          return;
        }
      } else {
        const bridge = shellBridge();
        const status = bridge ? await bridge.totp.getStatus() : null;
        if (!status?.configured) {
          showError('无法上锁', '验证器未绑定，请先在 设置 → 应用 → 隐私 中完成绑定。');
          return;
        }
      }
    } catch (reason) {
      showError('无法上锁', reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setOpen(false);
    useWorkspaceMenu.getState().close();
    lock();
  }

  function toggleTheme(): void {
    // Pin the opposite of whatever is currently showing. From 跟随系统 this
    // still does the intuitive thing: flips away from the resolved mode.
    setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');
  }

  async function captureNow(): Promise<void> {
    if (capturePending.current) return;
    const bridge = shellBridge();
    capturePending.current = true;
    try {
      const res = await captureMenuScreenshot(
        () =>
          bridge
            ? bridge.capture
                .window()
                .then((result) => ({ ...result, delivery: 'clipboard' as const }))
            : captureWebWindow(),
        () => {
          setOpen(false);
          useWorkspaceMenu.getState().close();
        },
      );
      if (res.ok) {
        pushToast({
          tone: 'success',
          title:
            res.delivery === 'native'
              ? '截图已生成'
              : res.delivery === 'download'
                ? '截图已生成并请求下载'
                : '截图已复制',
        });
      } else {
        showError('截图失败', res.error ?? '未知错误');
      }
    } catch (e) {
      showError('截图失败', errMsg(e));
    } finally {
      capturePending.current = false;
    }
  }

  // Right-click context menu for account items
  const [ctxMenu, setCtxMenu] = useState<{
    configId: string;
    displayName: string;
    anchor: HTMLElement;
  } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  async function deleteAccount(configId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setCtxMenu(null);
    setOpen(false);
    try {
      await client.bootstrap.deleteAccountConfig.mutate({ configId });
      // Refetch the account list
      void configs.refetch();
    } catch (e) {
      showError('删除失败', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // staleTime 0 + refetchOnMount always: the account配置 is written by
  // openAccount, i.e. AFTER bootstrap already cached this query. Without an
  // immediate refetch the popover would keep serving the pre-login list and a
  // freshly added account wouldn't show up until the 5min default staleTime
  // expired.
  const configs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: open && !isAccountGateway,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const instanceBridge =
    typeof window === 'undefined' ? undefined : shellBridge()?.accountInstances;
  const instanceConfigs = useQuery({
    queryKey: ['desktop-account-instances'],
    queryFn: () => instanceBridge?.list() ?? [],
    enabled: open && !!instanceBridge,
    staleTime: 0,
  });

  // 当前打开的是哪一条账号记录 —— 必须按 configId 认，不能按 uin：同一个 QQ
  // 号可以同时存在「在线账号」和「静态账号」两条记录，只比 uin 会把另一条
  // 也当成自己而从列表里滤掉，于是永远切不过去。
  const currentConfig = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const currentConfigId = currentConfig.data?.configId ?? null;

  async function signOut(): Promise<void> {
    if (busy) return;
    setBusy(true);
    if (!(await confirmMailAccountLeave())) {
      setBusy(false);
      return;
    }
    if (isAccountGateway) {
      rememberRemoteAccount(undefined);
      clearRemoteWorkspace();
      await fetch(accountGatewayPath('/_weq/leave-account'), { method: 'POST' }).catch(
        () => undefined,
      );
      location.assign('/_weq/accounts');
      return;
    }
    setOpen(false);
    try {
      await leaveAccountForBootstrap(queryClient);
    } catch (e) {
      showError('退出失败', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // 切号流程本体在 lib/switchAccount.ts —— 外部 MCP 触发的切换也走同一份实现。
  async function switchTo(cfg: SwitchTarget): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await switchAccount({
        queryClient,
        utils,
        target: cfg,
        currentConfigId,
        currentUin,
        onError: (e) => showError('切换账号失败', errMsg(e)),
      });
    } finally {
      setBusy(false);
    }
  }

  async function openInInstance(configId: string): Promise<void> {
    if (busy || !instanceBridge) return;
    setBusy(true);
    try {
      await instanceBridge.open(configId);
      setOpen(false);
    } catch (error) {
      showError('无法打开账号窗口', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  async function openAccountPicker(): Promise<void> {
    if (busy || !instanceBridge?.newWindow) return;
    setBusy(true);
    try {
      await instanceBridge.newWindow();
      setOpen(false);
    } catch (error) {
      showError('无法新建窗口', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  // configId 尚未取到时退回按 uin 过滤（旧行为），避免把当前账号也列出来。
  const localConfigs = new Map((configs.data ?? []).map((cfg) => [cfg.configId, cfg]));
  const desktopAccounts = instanceBridge ? (instanceConfigs.data ?? []) : [];
  const instances = new Map(desktopAccounts.map((cfg) => [cfg.configId, cfg]));
  const accounts = new Map(
    [...(configs.data ?? []), ...desktopAccounts].map((cfg) => [cfg.configId, cfg]),
  );
  const others = Array.from(accounts.values()).filter((c) =>
    currentConfigId ? c.configId !== currentConfigId : c.uin !== currentUin,
  );

  const controls = (
    <div className="weq-workspace-controls" aria-label="应用控制">
      <button
        type="button"
        className="weq-workspace-control"
        title={privacyEnabled ? '关闭隐私模式' : '开启隐私模式'}
        aria-label="隐私模式"
        aria-pressed={privacyEnabled}
        onClick={togglePrivacy}
      >
        {privacyEnabled ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
      {typeof children === 'function' ? null : children}
      {!IS_WEB || remote ? (
        <button
          type="button"
          className="weq-workspace-control"
          title={lockBlockReason() ?? '锁定 WeQ'}
          aria-label="锁定 WeQ"
          onClick={() => void lockNow()}
          disabled={busy || lockBlockReason() !== null}
        >
          <LockKeyhole size={18} strokeWidth={1.8} aria-hidden />
        </button>
      ) : null}
      <div ref={wrapRef} className="weq-rail-account-footer">
        <button
          type="button"
          className="weq-rail-account-avatar"
          title={`${currentName}（点击切换账号）`}
          aria-label="切换账号"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
        >
          <QqAvatar uin={currentUin} url={currentAvatarUrl ?? null} size={36} />
        </button>
      </div>
      <MenuCaptureButton onCapture={captureNow} />
      <button
        type="button"
        className="weq-workspace-control"
        title={resolvedTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
        aria-label={resolvedTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
        onClick={toggleTheme}
      >
        {resolvedTheme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
      </button>
    </div>
  );

  return (
    <>
      {typeof children === 'function' ? children(controls) : controls}
      {open ? (
        <OverlayLayer
          presentation="popover"
          anchor={wrapRef.current}
          className="weq-rail-account-layer"
          onClose={() => setOpen(false)}
        >
          <section className="weq-rail-account-popover" role="menu" aria-label="切换账号">
            <div className="weq-rail-account-popover-head">
              <span className="weq-rail-account-popover-title">切换账号</span>
              {instanceBridge?.newWindow ? (
                <button
                  type="button"
                  className="weq-rail-account-instance-action"
                  title="新建窗口"
                  aria-label="新建窗口"
                  disabled={busy}
                  onClick={() => void openAccountPicker()}
                >
                  <Plus size={16} aria-hidden />
                </button>
              ) : null}
            </div>
            {!isAccountGateway && configs.error ? (
              <div className="weq-rail-account-error" role="alert">
                <span>账号列表读取失败：{configs.error.message}</span>
                <button
                  type="button"
                  title="重新读取账号列表"
                  aria-label="重新读取账号列表"
                  disabled={configs.isFetching}
                  onClick={() => void configs.refetch()}
                >
                  <RefreshCw size={14} className={configs.isFetching ? 'weq-spin' : undefined} />
                </button>
                {configs.data?.length ? <small>以下为上次读取的记录。</small> : null}
              </div>
            ) : null}
            {isAccountGateway ? null : configs.isLoading ? (
              <div className="weq-rail-account-empty" role="status">
                <LoadingIndicator />
              </div>
            ) : others.length === 0 ? (
              configs.error ? null : (
                <div className="weq-rail-account-empty">暂无其它账号</div>
              )
            ) : (
              <ul className="weq-rail-account-list">
                {others.map((cfg) => {
                  const local = localConfigs.get(cfg.configId);
                  const opensWindow = !local || instances.get(cfg.configId)?.running;
                  const windowAction =
                    opensWindow && instances.get(cfg.configId)?.running
                      ? '转到窗口'
                      : '在新窗口打开';
                  return (
                    <li key={cfg.configId} className="weq-rail-account-instance-row">
                      <button
                        type="button"
                        className="weq-rail-account-item"
                        title={opensWindow ? windowAction : cfg.displayName || cfg.uin}
                        onClick={() =>
                          void (!opensWindow && local
                            ? switchTo(local)
                            : openInInstance(cfg.configId))
                        }
                        onContextMenu={(e) => {
                          if (!local) return;
                          e.preventDefault();
                          setCtxMenu({
                            configId: cfg.configId,
                            displayName: cfg.displayName || cfg.uin,
                            anchor: e.currentTarget,
                          });
                        }}
                        disabled={busy}
                      >
                        <span className="weq-acct-row-avatar-wrap">
                          <QqAvatar uin={cfg.uin} url={cfg.avatarUrl} size={40} />
                          {cfg.static && (
                            <span
                              className="weq-static-badge"
                              title={cfg.mobile ? 'Android 手机备份账号' : '静态离线账号'}
                              aria-label={cfg.mobile ? 'Android 手机备份账号' : '静态离线账号'}
                            >
                              {cfg.mobile ? (
                                <Smartphone size={9} strokeWidth={2.2} aria-hidden />
                              ) : (
                                <Database size={9} strokeWidth={2.2} aria-hidden />
                              )}
                            </span>
                          )}
                        </span>
                        <span className="weq-rail-account-item-text">
                          <span className="weq-rail-account-item-name">
                            {cfg.displayName || cfg.uin}
                          </span>
                          <span className="weq-rail-account-item-uin">
                            <span className="weq-number weq-number-inherit">{cfg.uin}</span>
                          </span>
                        </span>
                      </button>
                      {instanceBridge && cfg.uin !== currentUin ? (
                        <button
                          type="button"
                          className="weq-rail-account-instance-action"
                          title={windowAction}
                          aria-label={`${windowAction}：${cfg.displayName || cfg.uin}`}
                          disabled={busy}
                          onClick={() => void openInInstance(cfg.configId)}
                        >
                          <ExternalLink size={16} aria-hidden />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="weq-rail-account-signout"
              onClick={() => void signOut()}
              disabled={busy}
            >
              <span>{isAccountGateway ? '选择其他账号' : '退出登录'}</span>
              <LogOut size={18} strokeWidth={1.8} aria-hidden />
            </button>
          </section>
        </OverlayLayer>
      ) : null}
      {ctxMenu && (
        <OverlayLayer
          presentation="popover"
          anchor={ctxMenu.anchor}
          className="weq-rail-account-context-layer"
          onClose={closeCtxMenu}
        >
          <div
            className="weq-rail-account-ctx-menu"
            role="menu"
            aria-label="账号操作"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              data-danger="outline"
              type="button"
              onClick={() => void deleteAccount(ctxMenu.configId)}
              disabled={busy}
            >
              <Trash2 size={15} />
              <span>删除账号</span>
            </button>
          </div>
        </OverlayLayer>
      )}
    </>
  );
}
