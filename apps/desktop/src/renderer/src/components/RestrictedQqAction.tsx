import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LoaderCircle, Play, RefreshCw, Settings } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { QqDebugCopyDialog } from './QqDebugCopyDialog';
import { QQ_DEBUG_COPY_SWITCH_GUIDE } from './RestrictedQqAction.shared';
import type { QqDebugCopyPhase } from '../../../shared/qq_debug_copy';
import '../styles/qq-debug-copy.css';

const PHASE_LABELS: Record<QqDebugCopyPhase, string> = {
  idle: '正在检查 QQ',
  checking: '正在检查 QQ',
  copying: '正在准备 QQ',
  signing: '正在配置 QQ',
  verifying: '正在检查 QQ',
  launching: '正在打开 QQ',
  quitting: '正在退出普通 QQ',
  removing: '正在移除 QQ 副本',
};

/** 受限详情只呈现下一步；副本设置与账号设置共用独立浮窗。 */
export function RestrictedQqAction({
  needsQq,
  busy,
  onOpened,
  onEnable,
  onRetryCredentials,
  allowSwitch = true,
  hasCurrentAccount = true,
  currentAccountPid,
  children,
}: {
  needsQq: boolean;
  busy: boolean;
  onOpened: () => Promise<void>;
  onEnable: () => Promise<void>;
  onRetryCredentials?: () => Promise<void>;
  allowSwitch?: boolean;
  hasCurrentAccount?: boolean;
  currentAccountPid?: number | null;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState<QqDebugCopyPhase | null>(null);
  const status = trpc.bootstrap.qqDebugCopyStatus.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: (data) => (pending || (data && data.phase !== 'idle') ? 500 : 2000),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mounted = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const data = status.data;
  const running = Boolean(data?.runningPids.length);
  const signedInToCopy = currentAccountPid != null && data?.runningPids.includes(currentAccountPid);
  const signedInToOriginal =
    currentAccountPid != null && data?.sourceRunningPids.includes(currentAccountPid);
  const needsLogin = needsQq && !signedInToCopy;
  const canSwitch =
    allowSwitch &&
    (needsLogin || Boolean(onRetryCredentials)) &&
    !running &&
    signedInToOriginal &&
    data?.sourceRunningPids.length === 1;
  const opensQq = canSwitch || needsLogin;
  const copyWorking = Boolean(pending || (data && data.phase !== 'idle'));
  const working = copyWorking || (!opensQq && busy);
  const prepare = data?.state === 'missing' || data?.state === 'invalid';
  const blocked =
    opensQq && (data?.state === 'unmanaged' || (prepare && (!data?.sourceVersion || running)));
  const label = working
    ? opensQq
      ? PHASE_LABELS[data?.phase && data.phase !== 'idle' ? data.phase : (pending ?? 'checking')]
      : '正在启用 QQ 在线能力'
    : canSwitch
      ? '重新启动 QQ'
      : !opensQq
        ? onRetryCredentials
          ? '重试获取在线凭据'
          : '启用 QQ 在线能力'
        : data?.state === 'missing'
          ? '准备并打开 QQ'
          : data?.state === 'invalid'
            ? '修复并打开 QQ'
            : running
              ? hasCurrentAccount
                ? '登录当前账号'
                : '打开 QQ 登录窗口'
              : '打开 QQ';
  async function run(action: 'open' | 'activate' | 'switch' = 'open') {
    if (locked.current || copyWorking || (action === 'open' && working)) return;
    locked.current = true;
    setPending('checking');
    setError('');
    try {
      if (!opensQq && action === 'open') await (onRetryCredentials ?? onEnable)();
      else {
        await client.bootstrap.qqDebugCopyAction.mutate(
          action === 'switch' && currentAccountPid != null
            ? { action, expectedSourcePid: currentAccountPid }
            : { action },
        );
        if (!mounted.current) return;
        setPending('launching');
        if (action !== 'activate') {
          setWaiting(true);
          await onOpened();
        }
        await status.refetch();
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      if (mounted.current) await status.refetch().catch(() => undefined);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  }
  return (
    <>
      {needsLogin && (
        <p role={waiting ? 'status' : undefined}>
          {!hasCurrentAccount
            ? '请在 QQ 调试副本中登录要使用的 QQ 账号。'
            : signedInToOriginal
              ? '当前账号已登录普通 QQ。请在 QQ 调试副本中登录同一账号。'
              : '请在 QQ 调试副本中登录当前账号，登录后 WeQ 会自动更新状态。'}
        </p>
      )}
      {needsQq && signedInToCopy && (
        <p>当前账号已登录 QQ 调试副本。请保持登录，WeQ 会继续读取在线凭据，也可手动重试。</p>
      )}
      {canSwitch && <p>{QQ_DEBUG_COPY_SWITCH_GUIDE}</p>}
      {opensQq && data?.state === 'unmanaged' && (
        <p role="alert">副本位置已被其他应用占用，请在副本设置中查看。</p>
      )}
      {opensQq && prepare && running && (
        <p role="alert">请先从副本菜单退出 QQ，再修复并打开；其他 QQ 不受影响。</p>
      )}
      {opensQq && prepare && !data.sourceVersion && (
        <p role="alert">尚未检测到 QQ 安装。安装后此处会自动更新。</p>
      )}
      {(needsQq || canSwitch) && data && !data.readerReady && (
        <p role="alert">当前 WeQ 构建缺少调试权限，请使用带调试权限的桌面构建。</p>
      )}
      {(error || status.error) && <p role="alert">{error || status.error?.message}</p>}
      <div className="weq-restricted-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          disabled={working || blocked}
          aria-busy={working}
          onClick={() => void run(canSwitch ? 'switch' : 'open')}
        >
          {working ? (
            <LoaderCircle size={14} className="weq-restricted-progress-icon" />
          ) : canSwitch ? (
            <RefreshCw size={14} />
          ) : needsLogin ? (
            <Play size={14} />
          ) : (
            <KeyRound size={14} />
          )}
          {label}
        </button>
        <button type="button" className="weq-set-btn" onClick={() => setSettingsOpen(true)}>
          <Settings size={14} />
          副本设置
        </button>
        {running && allowSwitch && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={copyWorking || data?.state === 'invalid'}
            onClick={() => void run('activate')}
          >
            <Play size={14} />
            打开已有 QQ 窗口
          </button>
        )}
        {children}
      </div>
      {settingsOpen && <QqDebugCopyDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
