import { useContext } from 'react';
import { LoaderCircle, Play, RefreshCw, Settings } from 'lucide-react';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';
import { QQ_DEBUG_COPY_SWITCH_GUIDE } from './RestrictedQqAction.shared';
import { useTabActive } from './RetainedTabs.shared';
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

export function QqProxyRecovery({ onLaunch }: { onLaunch: () => void }) {
  const active = useTabActive();
  const qqProcess = trpc.bootstrap.getQqProcessState.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchInterval: active ? 3000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const running = !qqProcess.isError && qqProcess.data?.running === true;
  const canRestart = running && qqProcess.data?.canRestart === true;
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
          {launch.isLoading ? '正在打开 QQ' : running ? '登录其他账号' : '打开 QQ'}
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
      </div>
    </>
  );
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
  return { current, needsAttention, isError: query.isError, refetch: query.refetch };
}
