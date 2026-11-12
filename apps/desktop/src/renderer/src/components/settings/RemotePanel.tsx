import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTabActive } from '../RetainedTabs';
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  MonitorSmartphone,
  Play,
  QrCode,
  RefreshCw,
  Square,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { Card, Row, Toggle } from './controls';
import { Modal } from '../Dialog';
import { useModalBackground } from '../../lib/modalBackground';
import '../../styles/remote.css';
import {
  remoteAuthKeySchema,
  remoteDirectAddresses,
  type RemoteConnectionMode,
} from '../../../../shared/remote_bootstrap';
import {
  REMOTE_ACTIVITY_WINDOW,
  type RemoteDeviceInfo,
  type RemoteConnectionInfo,
} from '../../../../shared/remote_device';

const deviceTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function DeviceTime({ value, now }: { value: number | null; now?: number }) {
  if (value === null || !Number.isFinite(value) || Math.abs(value) > 8.64e15)
    return <span>暂无记录</span>;
  const full = deviceTime.format(value);
  const elapsed = now === undefined ? null : Math.max(0, now - value);
  const text =
    elapsed === null
      ? full
      : elapsed < 60_000
        ? '刚刚'
        : elapsed < 3_600_000
          ? `${Math.floor(elapsed / 60_000)} 分钟前`
          : elapsed < 86_400_000
            ? `${Math.floor(elapsed / 3_600_000)} 小时前`
            : full;
  return (
    <time dateTime={new Date(value).toISOString()} title={`${full}（北京时间）`}>
      {text}
    </time>
  );
}

const TAILSCALE_KEY_HINT = [
  '通过 Tailscale 跨网络连接',
  'Tailscale 提供内网穿透，让手机和电脑不在同一个 Wi-Fi 下时，也能连接 WeQ，无需公网 IP 或手动配置端口转发。',
  'WeQ Remote App 已内置 Tailscale，无需另外安装客户端。勾选「嵌入 Tailscale Key」后，扫码时 App 会使用 Key 加入电脑所在的 Tailscale 网络，完成跨网络连接所需的配置。',
].join('\n\n');

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
    deviceInfo?: RemoteDeviceInfo;
    lastConnection?: RemoteConnectionInfo;
  }[];
}

export function RemotePanel({
  data,
  qr,
  busy,
  error,
  onToggle,
  onLogin,
  onTailscale,
  onChangeNetwork,
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
  onTailscale?: (enabled: boolean) => void;
  onChangeNetwork?: () => void;
  onInvite: (bootstrap?: { authKey: string } | { endpoint: string }) => void;
  onDecide: (id: string, approve: boolean) => void;
  onRevoke: (id: string) => void;
  onCopy?: () => void;
}) {
  const active = useTabActive();
  const [now, setNow] = useState(Date.now());
  const [authKey, setAuthKey] = useState('');
  const [embedKey, setEmbedKey] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const keyForm = useRef<HTMLFormElement>(null);
  const generateButton = useRef<HTMLButtonElement>(null);
  const restorePairFocus = useRef(false);
  useModalBackground(keyForm, active && keyPrompt);
  useLayoutEffect(() => {
    if (!keyPrompt && restorePairFocus.current) {
      restorePairFocus.current = false;
      const button = generateButton.current;
      if (active && button && !button.closest('[hidden], [inert]'))
        button.focus({ preventScroll: true });
    }
  }, [active, keyPrompt]);
  const tailscale = data?.tailscaleEnabled ?? false;
  const tailscaleRunning =
    tailscale && data?.enabled && ['starting', 'login', 'online'].includes(data.network.state);
  const addresses = remoteDirectAddresses(data?.network.addresses ?? [], 'lan');
  const tailscaleAddress =
    tailscale && data?.network.state === 'online' ? data.network.address : undefined;
  const closePrompt = () => {
    restorePairFocus.current = true;
    setKeyPrompt(false);
    setAuthKey('');
    setKeyError(null);
  };
  useEffect(() => {
    setAuthKey('');
    setKeyPrompt(false);
    setKeyError(null);
  }, [data?.enabled, tailscale, active]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const online = data?.enabled && (addresses.length > 0 || !!tailscaleAddress);
  const activeQr = online && qr && data.invitationExpiresAt === qr.expiresAt && qr.expiresAt > now;
  const states = {
    starting: '正在启动',
    login: '等待登录',
    online: '已连接',
    offline: '已停止',
    error: '连接失败',
  };
  return (
    <div className="weq-set weq-remote">
      <Card icon={<MonitorSmartphone size={17} />} title="WeQ Remote">
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
        <section className="weq-remote-band weq-remote-address-band">
          <Row
            label="局域网 IP"
            control={
              <div className="weq-remote-addresses">
                {addresses.length ? (
                  addresses.map((address) => <code key={address}>{new URL(address).hostname}</code>)
                ) : (
                  <span>{data?.enabled ? '暂无可用地址' : '服务未开启'}</span>
                )}
              </div>
            }
          />
          <Row
            label="Tailscale IP"
            desc="WeQ 专用 Tailscale 服务"
            control={
              <div className="weq-remote-network-controls">
                <code role="status">
                  {tailscaleAddress
                    ? new URL(tailscaleAddress).hostname
                    : !data?.enabled || !tailscale
                      ? '未启动'
                      : states[data.network.state]}
                </code>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy || !data?.enabled}
                  onClick={() => onTailscale?.(!tailscaleRunning)}
                >
                  {tailscaleRunning ? <Square size={14} /> : <Play size={14} />}
                  {tailscaleRunning ? '停止服务' : '启动服务'}
                </button>
                {tailscale && data?.network.state === 'login' ? (
                  <button type="button" className="weq-set-btn" disabled={busy} onClick={onLogin}>
                    <ExternalLink size={14} />
                    登录 Tailscale
                  </button>
                ) : null}
                {tailscale ? (
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    title="更换 WeQ 专用 Tailscale 网络"
                    aria-label="更换 WeQ 专用 Tailscale 网络"
                    disabled={busy || !data?.enabled}
                    onClick={onChangeNetwork}
                  >
                    <RefreshCw size={14} />
                    更换 Tailscale 网络
                  </button>
                ) : null}
              </div>
            }
          />
          {data && (!data.available || !data.helperInstalled) ? (
            <p className="weq-remote-muted">
              {!data.available ? '仅桌面端可用' : '网络辅助程序未安装'}
            </p>
          ) : null}
          {error || data?.network.error ? (
            <p className="weq-remote-error" role="alert">
              {error || data?.network.error}
            </p>
          ) : null}
        </section>
        <section className="weq-remote-band">
          <div className="weq-remote-heading">
            <h4>配对手机</h4>
          </div>
          <div className="weq-remote-pair-actions">
            <button
              ref={generateButton}
              type="button"
              className="weq-set-btn"
              disabled={!online || busy || (embedKey && !tailscaleAddress)}
              onClick={() => {
                if (embedKey) setKeyPrompt(true);
                else onInvite(undefined);
              }}
            >
              {qr ? <RefreshCw size={14} /> : <QrCode size={14} />}
              生成配对码
            </button>
            <label className="weq-remote-consent" title={TAILSCALE_KEY_HINT}>
              <input
                type="checkbox"
                title={TAILSCALE_KEY_HINT}
                checked={embedKey}
                disabled={busy}
                onChange={(event) => setEmbedKey(event.target.checked)}
              />
              嵌入 Tailscale Key
            </label>
          </div>
          {embedKey && !tailscaleAddress ? (
            <p className="weq-remote-muted">请先启动并登录上方的 WeQ 专用 Tailscale 服务。</p>
          ) : null}
          {keyPrompt && active ? (
            <Modal
              title="输入 Tailscale Key"
              labelledBy="weq-remote-key-title"
              onClose={closePrompt}
              centered
              width={420}
              dismissOnOutside={false}
            >
              <form
                ref={keyForm}
                className="weq-remote-key-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const result = remoteAuthKeySchema.safeParse(authKey.trim());
                  if (!result.success) {
                    setKeyError('请输入有效的 Tailscale Auth Key。');
                    return;
                  }
                  const key = result.data;
                  closePrompt();
                  onInvite({ authKey: key });
                }}
              >
                <h3 id="weq-remote-key-title">输入 Tailscale Key</h3>
                <div className="weq-remote-bootstrap">
                  <label htmlFor="weq-remote-auth-key">Tailscale Auth Key</label>
                  <input
                    id="weq-remote-auth-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={211}
                    value={authKey}
                    onChange={(event) => setAuthKey(event.target.value)}
                    placeholder="tskey-auth-…"
                  />
                  <a
                    href="https://login.tailscale.com/admin/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    创建 Tailscale Key <ExternalLink size={12} />
                  </a>
                </div>
                {keyError ? (
                  <p className="weq-remote-error" role="alert">
                    {keyError}
                  </p>
                ) : null}
                <div className="weq-remote-pair-actions">
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    onClick={closePrompt}
                  >
                    取消
                  </button>
                  <button type="submit" className="weq-set-btn" disabled={!authKey.trim() || busy}>
                    <QrCode size={14} />
                    生成配对码
                  </button>
                </div>
              </form>
            </Modal>
          ) : null}
          {activeQr ? (
            <div className="weq-remote-pair">
              <img src={qr.qr} width={240} height={240} alt="WeQ Remote 一次性配对二维码" />
              <div>
                <h4>等待手机扫码</h4>
                <p>有效期剩余 {Math.max(0, Math.ceil((qr.expiresAt - now) / 1000))} 秒</p>
                <p>
                  {qr.pairingURL && new URL(qr.pairingURL).searchParams.has('authKey')
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
                      最近访问 <DeviceTime value={device.lastSeenAt} now={now} />
                    </span>
                    <span>
                      配对时间 <DeviceTime value={device.approvedAt} />
                    </span>
                  </div>
                  <details className="weq-remote-device-details">
                    <summary>
                      <ChevronRight size={14} />
                      设备详情
                    </summary>
                    <dl>
                      <div>
                        <dt>设备型号</dt>
                        <dd>{device.deviceInfo?.model ?? '未上报'}</dd>
                      </div>
                      <div>
                        <dt>系统版本</dt>
                        <dd>
                          {device.deviceInfo
                            ? `${device.deviceInfo.platform === 'ios' ? 'iOS / iPadOS' : 'Android'} ${device.deviceInfo.osVersion}`
                            : '未上报'}
                        </dd>
                      </div>
                      <div>
                        <dt>Remote 版本</dt>
                        <dd>
                          {device.deviceInfo
                            ? `${device.deviceInfo.appVersion} (${device.deviceInfo.appBuild})`
                            : '未上报'}
                        </dd>
                      </div>
                      <div>
                        <dt>最近连接 IP</dt>
                        <dd>{device.lastConnection?.ip ?? '暂无记录'}</dd>
                      </div>
                      <div>
                        <dt>连接方式</dt>
                        <dd>
                          {device.lastConnection
                            ? { lan: '局域网', tailscale: 'Tailscale', unknown: '未知网络' }[
                                device.lastConnection.route
                              ]
                            : '暂无记录'}
                        </dd>
                      </div>
                      <div>
                        <dt>最近访问</dt>
                        <dd>
                          <DeviceTime value={device.lastSeenAt} />
                        </dd>
                      </div>
                      <div>
                        <dt>设备标识</dt>
                        <dd>{device.id}</dd>
                      </div>
                    </dl>
                  </details>
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
      </Card>
    </div>
  );
}
