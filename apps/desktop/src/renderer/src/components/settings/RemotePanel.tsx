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

export interface RemoteStatus {
  available: boolean;
  helperInstalled: boolean;
  enabled: boolean;
  network: {
    state: 'starting' | 'login' | 'online' | 'offline' | 'error';
    address?: string;
    authUrl?: string;
    error?: string;
  };
  invitationExpiresAt: number | null;
  pending: { id: string; name: string; code: string; expiresAt: number }[];
  devices: { id: string; name: string; approvedAt: number | null; lastSeenAt: number | null }[];
}

export function RemotePanel({
  data,
  qr,
  busy,
  error,
  onToggle,
  onLogin,
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
  onInvite: () => void;
  onDecide: (id: string, approve: boolean) => void;
  onRevoke: (id: string) => void;
  onCopy?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const online = data?.enabled && data.network.state === 'online';
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
        <Row
          label="允许远程连接"
          desc="本次运行有效 · 仅开放在线状态"
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
                    : states[data.network.state]
                : '正在读取状态'}
            </strong>
            {data?.network.address && online ? <code>{data.network.address}</code> : null}
          </div>
          {data?.enabled && data.network.state === 'login' ? (
            <button type="button" className="weq-set-btn" disabled={busy} onClick={onLogin}>
              <ExternalLink size={14} />
              登录网络
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
            disabled={!online || busy}
            onClick={onInvite}
          >
            {qr ? <RefreshCw size={14} /> : <QrCode size={14} />}
            {qr ? '重新生成' : '生成配对码'}
          </button>
        </div>
        {activeQr ? (
          <div className="weq-remote-pair">
            <img src={qr.qr} width={240} height={240} alt="WeQ Remote 一次性配对二维码" />
            <div>
              <h4>等待手机扫码</h4>
              <p>有效期剩余 {Math.max(0, Math.ceil((qr.expiresAt - now) / 1000))} 秒</p>
              <p>扫码后将在此电脑确认设备。</p>
              {qr.pairingURL && onCopy ? (
                <button type="button" className="weq-set-btn" disabled={busy} onClick={onCopy}>
                  <Copy size={14} />
                  复制配对链接
                </button>
              ) : null}
            </div>
          </div>
        ) : (
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
        )}
        {data?.pending.map((request) => (
          <div className="weq-remote-request" key={request.id}>
            <Smartphone size={22} />
            <div className="weq-remote-device-main">
              <strong>{request.name}</strong>
              <span>核对手机上的校验码</span>
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
                <span>{device.lastSeenAt ? '已访问在线状态' : '尚未访问'} · 只读</span>
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
