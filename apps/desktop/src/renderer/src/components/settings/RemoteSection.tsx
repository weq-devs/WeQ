import { useEffect, useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { RemotePanel } from './RemotePanel';
import { Row, SectionHeader, Toggle } from './controls';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Check, Copy, ExternalLink, Globe } from 'lucide-react';
import { IS_WEB } from '../../lib/target';
import { copyTextToClipboard } from '../../im-template/template/clipboard';

export function RemoteSection() {
  return IS_WEB ? (
    <p className="weq-remote-muted">请在电脑客户端管理 Web 服务与远程连接。</p>
  ) : (
    <DesktopRemoteSection />
  );
}

function DesktopRemoteSection() {
  const status = trpc.remote.status.useQuery(undefined, { refetchInterval: 1500, retry: false });
  const web = trpc.remote.webStatus.useQuery(undefined, { refetchInterval: 1500, retry: false });
  const webToggle = trpc.remote.setWebEnabled.useMutation();
  const autoStart = trpc.remote.setWebAutoStart.useMutation();
  const confirm = useDialog((state) => state.confirm);
  const pushToast = useToast((state) => state.push);
  const toggle = trpc.remote.setEnabled.useMutation();
  const login = trpc.remote.openLogin.useMutation();
  const mode = trpc.remote.setMode.useMutation();
  const changeNetwork = trpc.remote.changeNetwork.useMutation();
  const refreshNetwork = trpc.remote.refreshNetwork.useMutation();
  const [inviting, setInviting] = useState(false);
  const decide = trpc.remote.decide.useMutation();
  const revoke = trpc.remote.revoke.useMutation();
  const [qr, setQr] = useState<{ qr: string; expiresAt: number; pairingURL?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copying, setCopying] = useState<'token' | 'pairing' | null>(null);
  const [copied, setCopied] = useState<'token' | 'pairing' | null>(null);
  const busy =
    toggle.isLoading ||
    mode.isLoading ||
    changeNetwork.isLoading ||
    refreshNetwork.isLoading ||
    login.isLoading ||
    inviting ||
    decide.isLoading ||
    revoke.isLoading ||
    webToggle.isLoading ||
    autoStart.isLoading ||
    copying !== null;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copySecret(kind: 'token' | 'pairing', read: () => Promise<string>) {
    if (copying) return;
    setCopying(kind);
    setCopied(null);
    setCopyError(null);
    try {
      const value = await read();
      if (!(await copyTextToClipboard(value))) throw new Error('clipboard unavailable');
      setCopied(kind);
      pushToast({ tone: 'success', title: kind === 'token' ? '访问令牌已复制' : '配对链接已复制' });
    } catch {
      const message = '复制失败，请确认服务仍在运行，并保持窗口处于前台后重试。';
      if (kind === 'token') setCopyError(message);
      else setError(message);
      pushToast({ tone: 'error', title: '复制失败', message });
    } finally {
      setCopying(null);
    }
  }
  useEffect(() => {
    if (!qr) return;
    if (!status.data?.enabled || status.data.invitationExpiresAt !== qr.expiresAt) {
      setQr(null);
      return;
    }
    const timer = window.setTimeout(() => setQr(null), Math.max(0, qr.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [qr, status.data]);
  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await status.refetch();
      await web.refetch();
    }
  }
  return (
    <div className="weq-set weq-remote-settings">
      <section className="weq-remote-web" aria-label="WeQ Web 服务">
        <SectionHeader icon={<Globe size={17} />} title="WeQ Web 服务" />
        <div className="weq-remote-web-controls">
          <Row
            label="启用 Web 服务"
            control={
              <Toggle
                label="启用 Web 服务"
                checked={web.data?.enabled ?? false}
                disabled={busy || !web.data?.assetsInstalled}
                onChange={(enabled) => void act(() => webToggle.mutateAsync({ enabled }))}
              />
            }
          />
          <Row
            label="启动 WeQ 时自动开启 Web 服务"
            control={
              <Toggle
                label="启动 WeQ 时自动开启 Web 服务"
                checked={web.data?.autoStart ?? false}
                disabled={busy || !web.data?.available}
                onChange={(enabled) => void act(() => autoStart.mutateAsync({ enabled }))}
              />
            }
          />
        </div>
        {web.data?.url ? (
          <div className="weq-remote-web-actions">
            <code className="weq-remote-web-address">{web.data.url}</code>
            <div className="weq-remote-web-buttons">
              <a
                className="weq-set-btn weq-set-btn-soft"
                href={web.data.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
                打开 Web
              </a>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft weq-remote-copy-token"
                disabled={busy}
                onClick={() => void copySecret('token', () => client.remote.webToken.mutate())}
              >
                {copied === 'token' ? <Check size={14} /> : <Copy size={14} />}
                <span role="status">
                  {copying === 'token'
                    ? '正在复制…'
                    : copied === 'token'
                      ? '已复制令牌'
                      : '复制访问令牌'}
                </span>
              </button>
            </div>
          </div>
        ) : null}
        {copyError ? (
          <p className="weq-remote-error" role="alert">
            {copyError}
          </p>
        ) : null}
        {web.data && !web.data.assetsInstalled ? (
          <p className="weq-remote-error">Web 页面尚未构建</p>
        ) : null}
        {web.data?.error ? (
          <p className="weq-remote-error" role="alert">
            {web.data.error}
          </p>
        ) : null}
      </section>
      <RemotePanel
        data={status.data}
        qr={qr}
        busy={busy || status.isLoading}
        error={error || status.error?.message || null}
        onToggle={(enabled) =>
          void act(async () => {
            setQr(null);
            await toggle.mutateAsync({ enabled });
            if (enabled && !web.data?.autoStart) {
              const recommended = await confirm(
                '让手机连接更方便',
                '建议启动 WeQ 时自动开启 Web 服务，手机配对后即可打开 WeQ。Web 服务仅监听本机，远程访问仍需设备授权。',
                { okLabel: '开启并记住', cancelLabel: '暂不开启', tone: 'info' },
              );
              if (recommended) {
                await webToggle.mutateAsync({ enabled: true });
                await autoStart.mutateAsync({ enabled: true });
              }
            }
          })
        }
        onLogin={() => void act(() => login.mutateAsync())}
        onRefresh={() =>
          void act(async () => {
            setQr(null);
            await refreshNetwork.mutateAsync();
          })
        }
        onMode={(value) =>
          void act(async () => {
            setQr(null);
            await mode.mutateAsync({ mode: value });
          })
        }
        onChangeNetwork={() =>
          void act(async () => {
            setQr(null);
            await changeNetwork.mutateAsync();
          })
        }
        onInvite={(bootstrap) =>
          void act(async () => {
            setQr(null);
            setInviting(true);
            try {
              // 不把入网 Key 和二维码留在 React Query mutation cache 中。
              const result = await client.remote.invite.mutate(bootstrap);
              const fresh = await status.refetch();
              if (fresh.data?.invitationExpiresAt === result.expiresAt) setQr(result);
            } finally {
              setInviting(false);
            }
          })
        }
        onDecide={(id, approve) => void act(() => decide.mutateAsync({ id, approve }))}
        onRevoke={(id) => void act(() => revoke.mutateAsync({ id }))}
        onCopy={() => void copySecret('pairing', async () => qr?.pairingURL ?? '')}
      />
    </div>
  );
}
