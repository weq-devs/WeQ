import { useContext, type ReactNode } from 'react';
import { LoaderCircle, Play, RefreshCw, Settings } from 'lucide-react';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import type { OnlineAccess } from '../lib/restrictedMode';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';
import { isQqProxyWaiting } from './QqProxyConnection.shared';
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
        if (navigate) navigate('account', 'qq-proxy-connection');
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
  const active = useTabActive();
  const qqProcess = trpc.bootstrap.getQqProcessState.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchInterval: active ? 3000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
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

export function useQqProxyStatus(poll: boolean, access: { data?: OnlineAccess; isError: boolean }) {
  const uin = useViewState((state) => (state.view === 'main' ? state.openedUin : null));
  const enabled = poll && Boolean(uin);
  const query = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 5000 : false,
  });
  const data = query.data;
  const source = access.data?.source;
  const sourceConfigId =
    source?.expectedAccountUin === uin ? source.expectedAccountConfigId : undefined;
  const current =
    uin && data?.accountUin === uin && (!sourceConfigId || data.accountConfigId === sourceConfigId)
      ? data
      : undefined;
  const needsAttention = Boolean(
    current?.enabled && current.connectionExpected && !current.connected,
  );
  const waiting =
    needsAttention &&
    !query.isError &&
    !access.isError &&
    isQqProxyWaiting(current, access.data, uin);
  return { current, needsAttention, waiting, isError: query.isError, refetch: query.refetch };
}
