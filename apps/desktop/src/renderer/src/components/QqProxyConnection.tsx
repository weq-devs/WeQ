import { useCallback, useContext, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Network, Play, X } from 'lucide-react';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useOverlayLayer } from '../lib/overlayStack';
import { useRenderDocument } from '../lib/renderDocument';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { useSurfaceOutside } from '../lib/surfaceOutside';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';
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
      {children}
      <ChevronRight size={14} aria-hidden />
    </button>
  );
}

export function QqProxyRecovery({
  onLaunch,
  beforeOpenSettings,
}: {
  onLaunch: () => void;
  beforeOpenSettings?: () => void;
}) {
  const active = useTabActive();
  const qqProcess = trpc.bootstrap.getQqProcessState.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchInterval: active ? 3000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const running = qqProcess.isError ? null : (qqProcess.data?.running ?? null);
  const canRestart = running === true && qqProcess.data?.canRestart === true;
  const refresh = () => {
    void qqProcess.refetch();
    onLaunch();
  };
  const launch = trpc.bootstrap.launchQq.useMutation({ onSettled: refresh });
  const restart = trpc.bootstrap.restartQq.useMutation({ onSettled: refresh });
  const restarting = restart.isLoading || qqProcess.data?.restarting === true;
  const busy = qqProcess.isInitialLoading || launch.isLoading || restarting;
  const failure = restart.error ?? launch.error;
  const label = restarting
    ? '正在重新启动 QQ'
    : launch.isLoading
      ? '正在打开 QQ'
      : canRestart
        ? '重新启动 QQ'
        : running === false
          ? '启动 QQ'
          : '打开 QQ';
  return (
    <>
      <p className="weq-set-note">
        {running === true
          ? '重新启动 QQ 后，在登录页配置代理。'
          : running === false
            ? '启动 QQ 后，在登录页配置代理。'
            : '如果 QQ 已运行，请重新启动 QQ，再在登录页配置代理。'}
      </p>
      {failure && <p role="alert">{failure.message}</p>}
      <div className="weq-restricted-actions">
        {(running !== true || canRestart || restarting) && (
          <button
            type="button"
            className="weq-set-btn weq-set-btn-primary"
            onClick={() => {
              if (canRestart) {
                launch.reset();
                restart.mutate();
              } else {
                restart.reset();
                launch.mutate();
              }
            }}
            disabled={busy}
            aria-busy={busy}
          >
            <Play size={14} aria-hidden />
            {label}
          </button>
        )}
        {beforeOpenSettings && (
          <QqProxySettingsLink beforeNavigate={beforeOpenSettings}>设置代理</QqProxySettingsLink>
        )}
      </div>
    </>
  );
}

const DISCONNECTED = 'QQ 代理未连接';

function DisconnectedIndicator({
  port,
  error,
  onLaunch,
}: {
  port: number;
  error: string;
  onLaunch: () => void;
}) {
  const document = useRenderDocument();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const close = useCallback(() => setOpen(false), []);
  const layer = useOverlayLayer(open);
  useSurfaceEscape(panel, close, open, false);
  useSurfaceOutside(panel, close, open, { anchor: trigger.current, consume: false });

  return (
    <div className="weq-titlebar-restriction">
      <div>
        <button
          ref={trigger}
          type="button"
          className="weq-restricted-indicator"
          title={DISCONNECTED}
          aria-label={DISCONNECTED}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Network size={15} aria-hidden />
          <span>{DISCONNECTED}</span>
        </button>
      </div>
      {open &&
        createPortal(
          <section
            ref={panel}
            role="dialog"
            aria-labelledby={titleId}
            className="weq-restricted-panel"
            style={{ zIndex: layer }}
          >
            <header>
              <h2 id={titleId}>
                <Network size={18} aria-hidden />
                {DISCONNECTED}
              </h2>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="关闭详情"
                aria-label="关闭详情"
                onClick={close}
              >
                <X size={16} aria-hidden />
              </button>
            </header>
            <div className="weq-restricted-body">
              {error && <p role="status">{error}</p>}
              <p>{`在 QQ 登录页选择 HTTP 代理，地址填 127.0.0.1，端口填 ${port}，用户名和密码留空，然后重新登录。`}</p>
              <QqProxyRecovery onLaunch={onLaunch} beforeOpenSettings={close} />
            </div>
          </section>,
          document.body,
        )}
    </div>
  );
}

export function QqProxyIndicator() {
  const uin = useViewState((state) => state.openedUin);
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const enabled = !!uin && settings.data?.qqProxyIndicatorEnabled === true;
  const status = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 5000 : false,
  });
  const data = status.data;
  if (
    !enabled ||
    status.isError ||
    data?.accountUin !== uin ||
    !data.connectionExpected ||
    data.connected
  )
    return null;
  return (
    <DisconnectedIndicator
      key={uin}
      port={data.port}
      error={data.error}
      onLaunch={() => void status.refetch()}
    />
  );
}
