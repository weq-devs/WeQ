import { Copy, ExternalLink, QrCode } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type RemoteInviteInput, remoteAuthKeySchema } from '../../../../shared/remote_bootstrap';
import { useModalBackground } from '../../lib/modalBackground';
import { Modal } from '../Dialog';

export interface RemoteInvitation {
  qr: string;
  expiresAt: number;
  pairingURL?: string;
}

export interface RemotePairingActions {
  onInvite: (input: RemoteInviteInput) => Promise<RemoteInvitation | undefined>;
  onCopy?: (url: string) => void;
}

export function RemotePairingDialog({
  canPairLocally,
  networkState,
  loginReady,
  invitationExpiresAt,
  pendingPairing,
  busy,
  error,
  networkError,
  onStart,
  onLogin,
  onInvite,
  onCopy,
  onClose,
}: RemotePairingActions & {
  canPairLocally: boolean;
  networkState: 'starting' | 'login' | 'online' | 'offline' | 'error';
  loginReady: boolean;
  invitationExpiresAt: number | null;
  pendingPairing: boolean;
  busy: boolean;
  error: string | null;
  networkError?: string;
  onStart: () => void;
  onLogin: () => void;
  onClose: () => void;
}) {
  const [route, setRoute] = useState(canPairLocally ? 'lan' : 'tailscale');
  const [existingNetwork, setExistingNetwork] = useState(false);
  const [authKey, setAuthKey] = useState('');
  const [keyError, setKeyError] = useState(false);
  const [invitation, setInvitation] = useState<RemoteInvitation>();
  const [now, setNow] = useState(Date.now);
  const form = useRef<HTMLFormElement>(null);
  const result = useRef<HTMLDivElement>(null);
  useModalBackground(form, true);

  useEffect(() => {
    if (!invitation) {
      form.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
      return;
    }
    result.current?.focus();
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= invitation.expiresAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [invitation]);

  const crossNetwork = route === 'tailscale';
  const ready = networkState === 'online';
  const expiresAt = invitation?.expiresAt ?? 0;
  const active = expiresAt > now && invitationExpiresAt === expiresAt;
  const errorMessage = keyError
    ? '请输入有效的 Tailscale 入网密钥。'
    : error || (crossNetwork ? networkError : null);
  const cannotGenerate =
    busy || (crossNetwork ? !ready || (!existingNetwork && !authKey.trim()) : !canPairLocally);

  async function generate() {
    if (cannotGenerate) return;
    let input: RemoteInviteInput = { mode: 'lan' };
    if (crossNetwork) {
      if (existingNetwork) input = { mode: 'existing' };
      else {
        const key = remoteAuthKeySchema.safeParse(authKey.trim());
        if (!key.success) {
          setKeyError(true);
          return;
        }
        input = { mode: 'tailscale', authKey: key.data };
      }
    }
    const next = await onInvite(input);
    if (!next) return;
    setNow(Date.now());
    setAuthKey('');
    setInvitation(next);
  }

  return (
    <Modal
      title="配对设备"
      labelledBy="weq-remote-pair-title"
      onClose={onClose}
      centered
      width={510}
      dismissOnOutside={false}
    >
      <form
        ref={form}
        className="weq-remote-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <h3 id="weq-remote-pair-title">配对设备</h3>
        {invitation ? (
          <>
            <div ref={result} tabIndex={-1}>
              {active ? (
                <div className="weq-remote-pair">
                  <img
                    src={invitation.qr}
                    width={240}
                    height={240}
                    alt="WeQ Remote 一次性配对二维码"
                  />
                  <div>
                    <h4>等待设备扫码</h4>
                    <p>用手机或车机上的 WeQ Remote 扫码，然后在电脑上确认。</p>
                    <p>有效期剩余 {Math.ceil((expiresAt - now) / 1000)} 秒</p>
                    {crossNetwork && !existingNetwork ? (
                      <p>配对码含入网密钥，请用要配对的设备扫码。</p>
                    ) : null}
                    {invitation.pairingURL && onCopy ? (
                      <button
                        type="button"
                        className="weq-set-btn"
                        disabled={busy}
                        onClick={() => onCopy(invitation.pairingURL!)}
                      >
                        <Copy size={14} /> 复制配对链接
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p role="status">
                  {pendingPairing ? '已收到配对请求，请在设置页确认设备。' : '配对码已失效。'}
                </p>
              )}
            </div>
            {error ? (
              <p className="weq-remote-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="weq-remote-pair-actions weq-remote-pair-footer">
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => setInvitation(undefined)}
              >
                返回连接方式
              </button>
              <button type="button" className="weq-set-btn weq-set-btn-primary" onClick={onClose}>
                {!active && pendingPairing ? '返回设置确认' : '关闭'}
              </button>
            </div>
          </>
        ) : (
          <>
            <fieldset className="weq-remote-pair-routes" disabled={busy}>
              <legend>设备怎么连接电脑？</legend>
              <label>
                <input
                  type="radio"
                  name="weq-remote-pair-route"
                  checked={!crossNetwork}
                  aria-labelledby="weq-remote-route-lan"
                  onChange={() => {
                    setRoute('lan');
                    setKeyError(false);
                  }}
                />
                <span>
                  <strong id="weq-remote-route-lan">同一局域网</strong>
                  <small>
                    {canPairLocally
                      ? '例如设备和电脑连着同一个 Wi-Fi。'
                      : '电脑暂无可用的局域网地址。'}
                  </small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="weq-remote-pair-route"
                  checked={crossNetwork}
                  aria-labelledby="weq-remote-route-tailscale"
                  onChange={() => setRoute('tailscale')}
                />
                <span>
                  <strong id="weq-remote-route-tailscale">跨网络连接</strong>
                  <small>设备和电脑不在同一局域网时，通过 Tailscale 连接。</small>
                </span>
              </label>
            </fieldset>
            {crossNetwork ? (
              <>
                <div className="weq-remote-pair-computer">
                  <div>
                    <strong>电脑端 Tailscale</strong>
                    <p className="weq-remote-muted" role="status">
                      {ready
                        ? '已加入 Tailscale 网络。'
                        : networkState === 'starting'
                          ? '正在启动…'
                          : networkState === 'login'
                            ? loginReady
                              ? '在浏览器完成登录后，回到这里继续配对。'
                              : '正在等待登录链接。'
                            : '启动并登录后，可继续配对。'}
                    </p>
                  </div>
                  {networkState === 'login' ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-primary"
                      disabled={busy || !loginReady}
                      onClick={onLogin}
                    >
                      <ExternalLink size={14} /> 登录 Tailscale
                    </button>
                  ) : !ready && networkState !== 'starting' ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-primary"
                      disabled={busy}
                      onClick={onStart}
                    >
                      {networkState === 'error' ? '重新启动 Tailscale' : '启动 Tailscale'}
                    </button>
                  ) : null}
                </div>
                {ready ? (
                  <>
                    {!existingNetwork ? (
                      <div className="weq-remote-bootstrap">
                        <div className="weq-remote-key-heading">
                          <label htmlFor="weq-remote-auth-key">Tailscale 入网密钥</label>
                          <a
                            href="https://login.tailscale.com/admin/settings/keys"
                            target="_blank"
                            rel="noreferrer"
                          >
                            创建一次性密钥 <ExternalLink size={12} />
                          </a>
                        </div>
                        <input
                          id="weq-remote-auth-key"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={211}
                          value={authKey}
                          disabled={busy}
                          aria-invalid={keyError || undefined}
                          aria-describedby="weq-remote-key-hint"
                          onChange={(event) => {
                            setAuthKey(event.target.value);
                            setKeyError(false);
                          }}
                          placeholder="粘贴 tskey-auth-…"
                        />
                        <p id="weq-remote-key-hint">
                          Remote 扫码时会用这把密钥加入电脑所在的网络。
                        </p>
                      </div>
                    ) : null}
                    <label className="weq-remote-consent">
                      <input
                        type="checkbox"
                        checked={existingNetwork}
                        disabled={busy}
                        onChange={(event) => {
                          setExistingNetwork(event.target.checked);
                          setKeyError(false);
                        }}
                      />
                      设备已加入电脑所在的 Tailscale 网络
                    </label>
                    {existingNetwork ? (
                      <p className="weq-remote-muted">请确认设备可以通过这个网络访问此电脑。</p>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
            {errorMessage ? (
              <p className="weq-remote-error" role="alert">
                {errorMessage}
              </p>
            ) : null}
            <div className="weq-remote-pair-actions weq-remote-pair-footer">
              <button type="button" className="weq-set-btn" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className="weq-set-btn weq-set-btn-primary"
                disabled={cannotGenerate}
              >
                <QrCode size={14} /> 生成配对码
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
