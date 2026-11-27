import { AnimatedDetails } from '../AnimatedDetails';
import { NumericText } from '../NumericText';
import { RemoteDeviceDetails, RemoteDeviceTime } from '../RemoteDeviceDetails';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTabActive } from '../RetainedTabs.shared';
import {
  ChevronRight,
  ExternalLink,
  MonitorSmartphone,
  Play,
  QrCode,
  Square,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { Card, Row, Toggle } from './controls';
import { RemotePairingDialog, type RemotePairingActions } from './RemotePairingDialog';
import { useDialog } from '../Dialog.shared';
import '../../styles/remote.css';
import {
  remoteDirectAddresses,
  type RemoteConnectionMode,
} from '../../../../shared/remote_bootstrap';
import {
  REMOTE_ACTIVITY_WINDOW,
  type RemoteDeviceInfo,
  type RemoteConnectionInfo,
} from '../../../../shared/remote_device';

export interface RemoteStatus {
  available: boolean;
  helperInstalled: boolean;
  enabled: boolean;
  tailscaleEnabled?: boolean;
  mode?: RemoteConnectionMode;
  network: {
    state: 'starting' | 'login' | 'online' | 'offline' | 'error';
    address?: string;
    authUrl?: string;
    error?: string;
    addresses?: string[];
  };
  invitationExpiresAt: number | null;
  pending: { id: string; name: string; code: string; expiresAt: number; scope?: string }[];
  devices: {
    id: string;
    name: string;
    approvedAt: number | null;
    lastSeenAt: number | null;
    scope?: string;
    accountConfigIds?: string[];
    deviceInfo?: RemoteDeviceInfo;
    lastConnection?: RemoteConnectionInfo;
  }[];
}

export function RemotePanel({
  data,
  busy,
  error,
  onToggle,
  onLogin,
  onTailscale,
  onChangeNetwork,
  onInvite,
  onReview,
  onRevoke,
  onCopy,
  accounts,
  accountError,
  onAccountAccess,
}: RemotePairingActions & {
  data?: RemoteStatus;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onLogin: () => void;
  onTailscale?: (enabled: boolean) => void;
  onChangeNetwork?: () => void;
  onReview: (id: string) => void;
  onRevoke: (id: string) => void;
  accounts?: { configId: string; displayName: string; uin: string; static: boolean }[];
  accountError?: string;
  onAccountAccess?: (deviceId: string, configIds: string[]) => void;
}) {
  const active = useTabActive();
  const [now, setNow] = useState(Date.now);
  const [pairingOpen, setPairingOpen] = useState(false);
  const pairButton = useRef<HTMLButtonElement>(null);
  const restorePairFocus = useRef(false);
  async function confirmDeviceRemoval(
    { id, name }: RemoteStatus['devices'][number],
    ownerDocument: Document,
  ) {
    const confirmed = await useDialog
      .getState()
      .confirm(
        '删除已配对设备？',
        `删除「${name}」会撤销这台设备的访问权限并断开连接。再次连接需要重新配对。`,
        { danger: 'outline', okLabel: '删除设备', ownerDocument },
      );
    if (confirmed) onRevoke(id);
  }

  useLayoutEffect(() => {
    if (!pairingOpen && restorePairFocus.current) {
      restorePairFocus.current = false;
      pairButton.current?.focus({ preventScroll: true });
    }
  }, [pairingOpen]);
  const enabled = data?.enabled ?? false;
  const tailscale = enabled && data?.tailscaleEnabled;
  const networkState = tailscale ? data.network.state : 'offline';
  const tailscaleRunning = ['starting', 'login', 'online'].includes(networkState);
  const addresses = remoteDirectAddresses(data?.network.addresses ?? [], 'lan');
  const tailscaleAddress = networkState === 'online' ? data?.network.address : undefined;
  const loginReady = !!data?.network.authUrl;
  useEffect(() => {
    if (!active || !enabled) setPairingOpen(false);
  }, [active, enabled]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const states = {
    starting: '正在启动',
    login: '等待登录',
    online: '已连接',
    offline: enabled ? '未启动' : 'Remote 连接已关闭',
    error: '连接失败',
  };
  const message = error || data?.network.error || null;
  return (
    <div className="weq-set weq-remote">
      <Card icon={<MonitorSmartphone size={17} />} title="Remote 服务器" resetId="remote">
        <Row
          settingId="remote-enabled"
          label="允许 Remote 连接"
          desc="新设备需要在这台电脑上确认。"
          control={
            <Toggle
              label="允许 Remote 连接"
              checked={enabled}
              disabled={busy || !data?.helperInstalled}
              onChange={onToggle}
            />
          }
        />
        <Row
          settingId="remote-pairing"
          label="配对新设备"
          desc={enabled ? '生成配对码，用 WeQ Remote 扫码。' : '开启 Remote 连接后可配对新设备。'}
          control={
            <button
              ref={pairButton}
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled={busy || !enabled}
              onClick={() => setPairingOpen(true)}
            >
              <QrCode size={14} /> 配对设备
            </button>
          }
        />
        {data && (!data.available || !data.helperInstalled) ? (
          <p className="weq-remote-muted">
            {!data.available ? '仅桌面端可用' : '网络辅助程序未安装'}
          </p>
        ) : null}
        {message && !pairingOpen ? (
          <p className="weq-remote-error" role="alert">
            {message}
          </p>
        ) : null}
      </Card>
      <Card title="跨网络连接" settingId="remote-tailscale">
        <Row
          label="电脑端 Tailscale"
          desc={<span role="status">{states[networkState]}</span>}
          control={
            <div className="weq-remote-network-controls">
              <button
                type="button"
                className="weq-set-btn"
                disabled={busy || !enabled}
                onClick={() => onTailscale?.(!tailscaleRunning)}
              >
                {tailscaleRunning ? <Square size={14} /> : <Play size={14} />}
                {tailscaleRunning ? '停止 Tailscale' : '启动 Tailscale'}
              </button>
              {networkState === 'login' ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-primary"
                  disabled={busy || !loginReady}
                  title={loginReady ? undefined : '正在等待登录链接'}
                  onClick={onLogin}
                >
                  <ExternalLink size={14} /> 登录 Tailscale
                </button>
              ) : null}
            </div>
          }
        />
        <AnimatedDetails className="weq-remote-network-details" data-setting-id="remote-lan">
          <summary>
            <ChevronRight size={14} aria-hidden /> 网络详情
          </summary>
          <Row
            label="局域网地址"
            control={
              <div className="weq-remote-addresses">
                {addresses.length ? (
                  addresses.map((address) => <code key={address}>{new URL(address).hostname}</code>)
                ) : (
                  <span className="weq-remote-muted">
                    {enabled ? '暂无可用地址' : '服务未开启'}
                  </span>
                )}
              </div>
            }
          />
          <Row
            label="Tailscale 地址"
            control={tailscaleAddress ? <code>{new URL(tailscaleAddress).hostname}</code> : '—'}
          />
          {tailscale ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={busy}
              onClick={async (event) => {
                const confirmed = await useDialog
                  .getState()
                  .confirm(
                    '更换 Tailscale 网络？',
                    '通过旧 Tailscale 网络连接的设备会断开。登录新网络后，可以为这些设备重新配对。',
                    { okLabel: '更换网络', ownerDocument: event.currentTarget.ownerDocument },
                  );
                if (confirmed) onChangeNetwork?.();
              }}
            >
              更换 Tailscale 网络
            </button>
          ) : null}
        </AnimatedDetails>
      </Card>
      {pairingOpen && active && enabled ? (
        <RemotePairingDialog
          canPairLocally={addresses.length > 0}
          networkState={
            tailscaleAddress ? 'online' : networkState === 'online' ? 'starting' : networkState
          }
          loginReady={loginReady}
          invitationExpiresAt={data?.invitationExpiresAt ?? null}
          pendingPairing={!!data?.pending.length}
          busy={busy}
          error={error}
          networkError={data?.network.error}
          onStart={() => onTailscale?.(true)}
          onLogin={onLogin}
          onInvite={onInvite}
          onCopy={onCopy}
          onClose={() => {
            restorePairFocus.current = true;
            setPairingOpen(false);
          }}
        />
      ) : null}
      {data?.pending.length ? (
        <Card title="待确认设备">
          {data?.pending.map((request) => (
            <div className="weq-remote-request" key={request.id}>
              <Smartphone size={22} />
              <div className="weq-remote-device-main">
                <strong>{request.name}</strong>
                <span>
                  {request.scope === 'web:access'
                    ? '核对校验码并选择要授权的账号'
                    : '核对手机上的校验码 · 仅在线状态'}
                </span>
                <code className="weq-remote-code">{request.code}</code>
              </div>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-primary"
                disabled={busy}
                onClick={() => onReview(request.id)}
              >
                查看请求
              </button>
            </div>
          ))}
        </Card>
      ) : null}
      <Card title="已配对设备" settingId="remote-devices">
        {!data?.devices.length ? (
          <p className="weq-remote-muted">暂无已配对设备</p>
        ) : (
          data.devices.map((device) => (
            <div className="weq-remote-device" key={device.id}>
              <Smartphone size={22} />
              <div className="weq-remote-device-main">
                <div className="weq-remote-device-title">
                  <strong>{device.name}</strong>
                  <span
                    className="weq-remote-activity"
                    data-active={
                      !!data.enabled &&
                      device.lastSeenAt !== null &&
                      now - device.lastSeenAt < REMOTE_ACTIVITY_WINDOW
                    }
                    title="根据最近 45 秒内的授权访问判断活跃状态"
                  >
                    {!data.enabled
                      ? '服务已关闭'
                      : device.lastSeenAt === null
                        ? '尚未访问'
                        : now - device.lastSeenAt < REMOTE_ACTIVITY_WINDOW
                          ? '近期活跃'
                          : '未活跃'}
                  </span>
                </div>
                <span>{device.scope === 'web:access' ? 'WeQ Web 访问' : '仅在线状态'}</span>
                <div className="weq-remote-device-times">
                  <span>
                    最近访问 <RemoteDeviceTime value={device.lastSeenAt} now={now} />
                  </span>
                  <span>
                    配对时间 <RemoteDeviceTime value={device.approvedAt} />
                  </span>
                </div>
                {device.scope === 'web:access' && onAccountAccess && (
                  <AnimatedDetails className="weq-remote-device-details weq-remote-account-access">
                    <summary>
                      <ChevronRight size={14} />
                      访问权限
                    </summary>
                    {accountError && (
                      <p className="weq-remote-muted" role="alert">
                        {accountError}
                      </p>
                    )}
                    {accounts?.length === 0 && <p className="weq-remote-muted">暂无已保存账号</p>}
                    {accounts?.map((account) => {
                      const selected = device.accountConfigIds ?? [];
                      return (
                        <Row
                          key={account.configId}
                          label={
                            <span className="weq-remote-account-label">
                              <span className="weq-remote-account-name" title={account.displayName}>
                                {account.displayName}
                              </span>
                              <span className="weq-remote-account-number">
                                <NumericText>{account.uin}</NumericText>
                                {account.static ? ' · 静态备份' : null}
                              </span>
                            </span>
                          }
                          control={
                            <Toggle
                              label={`允许${device.name}访问${account.displayName}`}
                              checked={selected.includes(account.configId)}
                              disabled={busy}
                              onChange={(enabled) =>
                                onAccountAccess(
                                  device.id,
                                  enabled
                                    ? [...selected, account.configId]
                                    : selected.filter((id) => id !== account.configId),
                                )
                              }
                            />
                          }
                        />
                      );
                    })}
                  </AnimatedDetails>
                )}
                <RemoteDeviceDetails device={device} />
              </div>
              <button
                data-danger="outline"
                type="button"
                className="weq-set-iconbtn"
                title="删除设备"
                aria-label={`删除 ${device.name}`}
                disabled={busy}
                onClick={(event) =>
                  void confirmDeviceRemoval(device, event.currentTarget.ownerDocument)
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
