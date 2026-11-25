import { useContext, type ReactNode } from 'react';
import { LoaderCircle, Play, RefreshCw, Settings } from 'lucide-react';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';
import { QQ_DEBUG_COPY_SWITCH_GUIDE } from './RestrictedQqAction.shared';
import { SettingsNavigateContext } from './settings/controls.shared';
import '../styles/restricted-mode.css';

export function QqProxySettingsLink({
  children = 'QQ 代理连接',
  beforeNavigate,
}: {
  children?: string;
  beforeNavigate?: () => void;
}) {
  const navigate = useContext(SettingsNavigateContext);
  return (
    <button
      type="button"
      className="weq-set-btn"
      onClick={() => {
        beforeNavigate?.();
        if (navigate) navigate('qq-proxy', 'qq-proxy-connection');
        else requestOpenSettings('qqProxyConnection');
      }}
    >
      <Settings size={14} aria-hidden />
      {children}
    </button>
  );
}

export function QqProxyRecovery({
  onLaunch,
  needsCurrentLogin,
  children,
}: {
  onLaunch: () => void;
  needsCurrentLogin: boolean;
  children?: ReactNode;
}) {
  // 代理详情已在等待连接时轮询进程状态，操作按钮复用同一结果。
  const qqProcess = useQqProcessState(false);
  const running = !qqProcess.isError && qqProcess.data?.running === true;
  const canRestart = running && !needsCurrentLogin && qqProcess.data?.canRestart === true;
  const refresh = () => {
    void qqProcess.refetch();
    onLaunch();
  };
  const launch = trpc.bootstrap.launchQq.useMutation({ onSettled: refresh });
  const restart = trpc.bootstrap.restartQq.useMutation({ onSettled: refresh });
  const opening = qqProcess.isInitialLoading || launch.isLoading;
  const restarting =
    !launch.isLoading && (restart.isLoading || qqProcess.data?.restarting === true);
  const busy = opening || restarting;
  const failure = restart.error ?? launch.error;
  return (
    <>
      {canRestart && qqProcess.data?.switchingToDebugCopy && (
        <p className="weq-set-note">{QQ_DEBUG_COPY_SWITCH_GUIDE}</p>
      )}
      {failure && <p role="alert">{failure.message}</p>}
      <div className="weq-restricted-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          onClick={() => {
            restart.reset();
            launch.mutate({ newInstance: running });
          }}
          disabled={busy}
          aria-busy={opening}
        >
          {opening ? (
            <LoaderCircle size={14} className="weq-restricted-progress-icon" aria-hidden />
          ) : (
            <Play size={14} aria-hidden />
          )}
          {launch.isLoading
            ? '正在打开 QQ'
            : running
              ? needsCurrentLogin
                ? '登录当前账号'
                : '打开 QQ 登录窗口'
              : '打开 QQ'}
        </button>
        {(canRestart || restarting) && (
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => {
              launch.reset();
              restart.mutate();
            }}
            disabled={busy || !canRestart}
            aria-busy={restarting}
          >
            {restarting ? (
              <LoaderCircle size={14} className="weq-restricted-progress-icon" aria-hidden />
            ) : (
              <RefreshCw size={14} aria-hidden />
            )}
            {restarting ? '正在重新启动 QQ' : '重新启动 QQ'}
          </button>
        )}
        {children}
      </div>
    </>
  );
}

function useQqProcessState(poll: boolean) {
  return trpc.bootstrap.getQqProcessState.useQuery(undefined, {
    enabled: poll,
    staleTime: 0,
    refetchInterval: poll ? 3000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useQqProxyWaiting(
  proxy:
    | { enabled: boolean; running: boolean; connected: boolean; connecting: boolean }
    | undefined,
  poll: boolean,
) {
  const waitingForRequest =
    proxy?.enabled === true && proxy.running && !proxy.connected && !proxy.connecting;
  const qqProcess = useQqProcessState(poll && waitingForRequest);
  return waitingForRequest && !qqProcess.isError && qqProcess.data?.running === true;
}

export function useQqProxyStatus(poll: boolean, sourceConfigId?: string) {
  const uin = useViewState((state) => (state.view === 'main' ? state.openedUin : null));
  const enabled = poll && Boolean(uin);
  const query = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 5000 : false,
  });
  const data = query.data;
  const current =
    uin && data?.accountUin === uin && (!sourceConfigId || data.accountConfigId === sourceConfigId)
      ? data
      : undefined;
  const needsAttention = Boolean(
    current?.enabled && current.connectionExpected && !current.connected,
  );
  const waiting = useQqProxyWaiting(
    needsAttention && !query.isError ? current : undefined,
    enabled,
  );
  return { current, needsAttention, waiting, isError: query.isError, refetch: query.refetch };
}
