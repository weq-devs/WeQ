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
  const launch = trpc.bootstrap.launchQq.useMutation({ onSuccess: onLaunch });
  return (
    <>
      <p className="weq-set-note">
        请在运行 WeQ 的电脑上操作。若 QQ 已运行，请先完全退出，再启动 QQ。
      </p>
      {launch.error && <p role="alert">{launch.error.message}</p>}
      <div className="weq-restricted-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          onClick={() => launch.mutate()}
          disabled={launch.isLoading}
          aria-busy={launch.isLoading}
        >
          <Play size={14} aria-hidden />
          {launch.isLoading ? '正在启动 QQ' : '启动 QQ'}
        </button>
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
