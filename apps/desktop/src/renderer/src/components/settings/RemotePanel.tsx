import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { Row, SectionHeader, Toggle } from './controls';
import '../../styles/remote.css';
import {
  remoteAuthKeySchema,
  remoteDirectAddresses,
  type RemoteConnectionMode,
} from '../../../../shared/remote_bootstrap';

export interface RemoteStatus {
  available: boolean;
  helperInstalled: boolean;
  enabled: boolean;
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
  }[];
}

export function RemotePanel({
  data,
  qr,
  busy,
  error,
  onToggle,
  onLogin,
  onMode,
  onChangeNetwork,
  onRefresh,
  onInvite,
  onDecide,
  onRevoke,
  onCopy,
}: {
  data?: RemoteStatus;
  qr: { qr: string; expiresAt: number; pairingURL?: string } | null;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onLogin: () => void;
  onMode?: (mode: RemoteConnectionMode) => void;
  onChangeNetwork?: () => void;
  onRefresh?: () => void;
  onInvite: (bootstrap?: { authKey: string } | { endpoint: string }) => void;
  onDecide: (id: string, approve: boolean) => void;
  onRevoke: (id: string) => void;
  onCopy?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [authKey, setAuthKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const tailscale = data?.mode === 'tailscale';
  const existing = data?.mode === 'existing';
  const networkMode = existing || tailscale;
  const [phoneMode, setPhoneMode] = useState<'existing' | 'tailscale'>(
    existing ? 'existing' : 'tailscale',
  );
  useEffect(() => {
    if (data?.mode === 'existing' || data?.mode === 'tailscale') setPhoneMode(data.mode);
  }, [data?.mode]);
  const addresses = remoteDirectAddresses(
    data?.network.addresses ?? [],
    existing ? 'existing' : 'lan',
  );
  useEffect(() => {
    setAuthKey('');
    setEndpoint('');
  }, [data?.enabled, data?.mode]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const online =
    data?.enabled &&
    (tailscale
      ? data.network.state === 'online'
      : data.network.addresses
        ? addresses.length > 0
        : !existing && data.network.state === 'online');
  const activeQr = online && qr && data.invitationExpiresAt === qr.expiresAt && qr.expiresAt > now;
  const states = {
    starting: '正在连接网络',
    login: '等待网络登录',
    online: '网络已连接',
    offline: '已停止',
    error: '连接失败',
  };
  return (
    <div className="weq-set weq-remote">
      <SectionHeader icon={<MonitorSmartphone size={17} />} title="WeQ Remote" />
      <section className="weq-remote-band">
        <div className="weq-remote-modes" role="group" aria-label="连接方式">
          <button
            type="button"
            aria-pressed={!networkMode}
            disabled={busy}
            onClick={() => onMode?.('lan')}
          >
            局域网
          </button>
          <button
            type="button"
            aria-pressed={networkMode}
            disabled={busy}
            onClick={() => onMode?.(phoneMode)}
          >
            Tailscale
          </button>
        </div>
        {networkMode ? (
          <div className="weq-remote-phone-choice">
            <Row
              label="手机上"
              control={
                <div
                  className="weq-remote-phone-modes"
                  role="group"
                  aria-label="手机上的 Tailscale"
                >
                  <button
                    type="button"
                    aria-pressed={existing}
                    disabled={busy}
                    onClick={() => onMode?.('existing')}
                  >
                    已有 Tailscale
                  </button>
                  <button
                    type="button"
                    aria-pressed={tailscale}
                    disabled={busy}
                    onClick={() => onMode?.('tailscale')}
                  >
                    没有 Tailscale
                  </button>
                </div>
              }
            />
          </div>
        ) : null}
        <Row
          label="允许远程连接"
          desc="首次连接在电脑批准，之后自动重连"
          control={
            <Toggle
              label="允许远程连接"
              checked={data?.enabled ?? false}
              disabled={busy || !data?.helperInstalled}
              onChange={onToggle}
            />
          }
        />
        <div className="weq-remote-state" role="status">
          <ShieldCheck size={17} />
          <div>
            <strong>
              {data
                ? !data.available
                  ? '仅桌面端可用'
                  : !data.helperInstalled
                    ? '网络辅助程序未安装'
                    : !tailscale && online
                      ? existing
                        ? 'Tailscale 地址已就绪'
                        : '局域网已就绪'
                      : existing && data.enabled
                        ? '未检测到 Tailscale 地址'
                        : states[data.network.state]
                : '正在读取状态'}
            </strong>
            {online && (tailscale ? data?.network.address : addresses[0]) ? (
              <code>{tailscale ? data?.network.address : addresses[0]}</code>
            ) : null}
          </div>
          {data?.enabled && networkMode ? (
            <>
              {data.network.state === 'login' ? (
                <button type="button" className="weq-set-btn" disabled={busy} onClick={onLogin}>
                  <ExternalLink size={14} />
                  验证 Tailscale
                </button>
              ) : null}
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={busy}
                onClick={onChangeNetwork}
              >
                <RefreshCw size={14} />
                更换网络
              </button>
            </>
          ) : null}
          {existing && data?.enabled ? (
            <button
              type="button"
              className="weq-set-iconbtn"
              title="刷新连接地址"
              aria-label="刷新连接地址"
              disabled={busy}
              onClick={onRefresh}
            >
              <RefreshCw size={16} />
            </button>
          ) : null}
        </div>
        {error || data?.network.error ? (
          <p className="weq-remote-error" role="alert">
            {error || data?.network.error}
          </p>
        ) : null}
      </section>
      <section className="weq-remote-band">
        <div className="weq-remote-heading">
          <h4>配对手机</h4>
          <button
            type="button"
            className="weq-set-btn"
            disabled={
              !online ||
              busy ||
              (tailscale && !remoteAuthKeySchema.safeParse(authKey.trim()).success)
            }
            onClick={() => {
              const bootstrap = tailscale
                ? { authKey: authKey.trim() }
                : endpoint && addresses.includes(endpoint)
                  ? { endpoint }
                  : undefined;
              setAuthKey('');
              onInvite(bootstrap);
            }}
          >
            {qr ? <RefreshCw size={14} /> : <QrCode size={14} />}
            {qr ? '重新生成' : '生成配对码'}
          </button>
        </div>
        {!tailscale && addresses.length > 1 ? (
          <label className="weq-remote-bootstrap">
            电脑地址
            <select
              value={addresses.includes(endpoint) ? endpoint : addresses[0]}
              onChange={(event) => setEndpoint(event.target.value)}
            >
              {addresses.map((address) => (
                <option key={address} value={address}>
                  {address}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {tailscale ? (
          <div className="weq-remote-bootstrap">
            <label htmlFor="weq-remote-auth-key">一次性 Auth Key</label>
            <input
              id="weq-remote-auth-key"
              type="password"
              value={authKey}
              maxLength={211}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder="tskey-auth-…"
              onChange={(event) => setAuthKey(event.target.value)}
            />
            <p>
              创建 Key 时关闭 Reusable 和 Ephemeral，手机只需入网一次。二维码含密钥，请勿分享；删除
              WeQ 设备不会撤销入网密钥，网络设备需在 Tailscale 管理台移除。
            </p>
            <a
              href="https://login.tailscale.com/admin/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              生成 Auth Key <ExternalLink size={12} />
            </a>
          </div>
        ) : null}
        {activeQr ? (
          <div className="weq-remote-pair">
            <img src={qr.qr} width={240} height={240} alt="WeQ Remote 一次性配对二维码" />
            <div>
              <h4>等待手机扫码</h4>
              <p>有效期剩余 {Math.max(0, Math.ceil((qr.expiresAt - now) / 1000))} 秒</p>
              <p>
                {qr.pairingURL && new URL(qr.pairingURL).searchParams.get('v') === '2'
                  ? '含一次性入网密钥 · 请勿分享'
                  : '扫码后将在此电脑确认设备。'}
              </p>
              {qr.pairingURL && onCopy ? (
                <button type="button" className="weq-set-btn" disabled={busy} onClick={onCopy}>
                  <Copy size={14} />
                  复制配对链接
                </button>
              ) : null}
            </div>
          </div>
        ) : qr ? (
          <div className="weq-remote-empty">
            <QrCode size={32} strokeWidth={1.3} />
            <span>
              {data?.pending.length
                ? '等待确认设备'
                : qr && online
                  ? '配对码已失效'
                  : '暂无有效配对码'}
            </span>
          </div>
        ) : null}
        {data?.pending.map((request) => (
          <div className="weq-remote-request" key={request.id}>
            <Smartphone size={22} />
            <div className="weq-remote-device-main">
              <strong>{request.name}</strong>
              <span>
                {request.scope === 'web:access'
                  ? '核对校验码 · 允许访问完整 WeQ Web（含聊天记录与操作）'
                  : '核对手机上的校验码 · 仅在线状态'}
              </span>
              <code className="weq-remote-code">{request.code}</code>
            </div>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="拒绝配对"
              aria-label={`拒绝 ${request.name}`}
              disabled={busy}
              onClick={() => onDecide(request.id, false)}
            >
              <X size={17} />
            </button>
            <button
              type="button"
              className="weq-set-btn"
              disabled={busy}
              onClick={() => onDecide(request.id, true)}
            >
              <Check size={15} />
              允许配对
            </button>
          </div>
        ))}
      </section>
      <section className="weq-remote-band">
        <div className="weq-remote-heading">
          <h4>已配对设备</h4>
          <span>{data?.devices.length ?? 0} 台</span>
        </div>
        {!data?.devices.length ? (
          <p className="weq-remote-muted">暂无已配对设备</p>
        ) : (
          data.devices.map((device) => (
            <div className="weq-remote-device" key={device.id}>
              <Smartphone size={22} />
              <div className="weq-remote-device-main">
                <strong>{device.name}</strong>
                <span>{device.scope === 'web:access' ? 'WeQ Web 访问' : '仅在线状态'}</span>
              </div>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="撤销设备授权"
                aria-label={`撤销 ${device.name}`}
                disabled={busy}
                onClick={() => onRevoke(device.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
