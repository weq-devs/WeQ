import { useEffect, useRef, useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { RemotePanel } from './RemotePanel';
import { useTabActive } from '../RetainedTabs.shared';
import { Card, Row, Toggle, SectionHeader } from './controls';
import { useToast } from '../Toast.shared';
import { Check, Copy, ExternalLink, Globe } from 'lucide-react';
import { IS_WEB } from '../../lib/target.shared';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { useRemotePairingReview } from '../RemoteRequests.shared';

export function RemoteSection() {
  return (
    <div className="weq-set weq-remote-settings">
      <SectionHeader title="Web 与 Remote" page="remote" />
      {IS_WEB ? (
        <p className="weq-remote-muted">请在电脑客户端管理本机浏览器访问与远程连接。</p>
      ) : (
        <>
          <LocalBrowserSection />
          <RemoteConnectionSection />
        </>
      )}
    </div>
  );
}

function useEntryActions(active: boolean, refetch: () => Promise<unknown>) {
  const activity = useRef(active);
  activity.current = active;
  const actingRef = useRef(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useToast((state) => state.push);
  async function act(action: () => Promise<unknown>) {
    if (actingRef.current) return;
    actingRef.current = true;
    setActing(true);
    setError(null);
    try {
      await action();
      if (activity.current) await refetch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // 与网络轮询的异常 toast 共用 key，同一原因只保留一条横幅。
      pushToast({
        tone: 'error',
        title: 'WeQ Remote 操作失败',
        message,
        key: 'remote-service-error',
      });
    } finally {
      actingRef.current = false;
      setActing(false);
    }
  }
  return { acting, error, act };
}

function useSecretCopy(active: boolean, title: string) {
  const activity = useRef(active);
  activity.current = active;
  const pushToast = useToast((state) => state.push);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setCopied(false);
      return;
    }
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied, active]);

  async function copy(read: () => Promise<string>) {
    if (copying) return;
    setCopying(true);
    setCopied(false);
    setError(null);
    try {
      const value = await read();
      if (!(await copyTextToClipboard(value))) throw new Error('clipboard unavailable');
      if (activity.current) setCopied(true);
      pushToast({ tone: 'success', title });
    } catch {
      const message = '复制失败，请确认服务仍在运行，并保持窗口处于前台后重试。';
      setError(message);
      pushToast({ tone: 'error', title: '复制失败', message });
    } finally {
      setCopying(false);
    }
  }
  return { copying, copied, error, copy };
}

function LocalBrowserSection() {
  const active = useTabActive();
  const web = trpc.remote.webStatus.useQuery(undefined, {
    enabled: active,
    refetchInterval: active ? 1500 : false,
    retry: false,
  });
  const webToggle = trpc.remote.setWebEnabled.useMutation();
  const autoStart = trpc.remote.setWebAutoStart.useMutation();
  const { acting, error, act } = useEntryActions(active, web.refetch);
  const secret = useSecretCopy(active, '访问令牌已复制');
  const busy = webToggle.isLoading || autoStart.isLoading || acting || secret.copying;
  const message = error || secret.error || web.error?.message || web.data?.error;
  return (
    <section className="weq-remote-web" aria-label="本机浏览器访问">
      <Card icon={<Globe size={17} />} title="本机浏览器访问">
        <div className="weq-remote-web-controls">
          <Row
            label="允许本机浏览器访问"
            control={
              <Toggle
                label="允许本机浏览器访问"
                checked={web.data?.enabled ?? false}
                disabled={busy || !web.data?.assetsInstalled}
                onChange={(enabled) => void act(() => webToggle.mutateAsync({ enabled }))}
              />
            }
          />
          <Row
            label="启动 WeQ 时自动允许本机浏览器访问"
            control={
              <Toggle
                label="启动 WeQ 时自动允许本机浏览器访问"
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
                onClick={() => void secret.copy(() => client.remote.webToken.mutate())}
              >
                {secret.copied ? <Check size={14} /> : <Copy size={14} />}
                <span role="status">
                  {secret.copying ? '正在复制…' : secret.copied ? '已复制令牌' : '复制访问令牌'}
                </span>
              </button>
            </div>
          </div>
        ) : null}
        {message ? (
          <p className="weq-remote-error" role="alert">
            {message}
          </p>
        ) : null}
        {web.data && !web.data.assetsInstalled ? (
          <p className="weq-remote-error">Web 页面尚未构建</p>
        ) : null}
      </Card>
    </section>
  );
}

function RemoteConnectionSection() {
  const active = useTabActive();
  const status = trpc.remote.status.useQuery(undefined, {
    enabled: active,
    refetchInterval: active ? 1500 : false,
    retry: false,
  });
  const { acting, error, act } = useEntryActions(active, status.refetch);
  const secret = useSecretCopy(active, '配对链接已复制');
  const toggle = trpc.remote.setEnabled.useMutation();
  const login = trpc.remote.openLogin.useMutation();
  const tailscale = trpc.remote.setTailscaleEnabled.useMutation();
  const changeNetwork = trpc.remote.changeNetwork.useMutation();
  const revoke = trpc.remote.revoke.useMutation();
  const accounts = trpc.remote.accounts.useQuery(undefined, { enabled: active });
  const grant = trpc.remote.setAccountConfigIds.useMutation();
  const [qr, setQr] = useState<{ qr: string; expiresAt: number; pairingURL?: string } | null>(null);
  const busy =
    toggle.isLoading ||
    tailscale.isLoading ||
    changeNetwork.isLoading ||
    login.isLoading ||
    revoke.isLoading ||
    grant.isLoading ||
    acting ||
    secret.copying;
  // 辅助进程的异步失败（退出、尚未就绪等）不走 mutation 抛错，只能从状态轮询里拿到。
  const pushToast = useToast((state) => state.push);
  const lastNetworkError = useRef<string | null>(null);
  useEffect(() => {
    const message = status.data?.network.error ?? null;
    if (!message) {
      lastNetworkError.current = null;
      return;
    }
    if (message === lastNetworkError.current) return;
    lastNetworkError.current = message;
    pushToast({
      tone: 'error',
      title: 'WeQ Remote 网络异常',
      message,
      key: 'remote-service-error',
    });
  }, [status.data?.network.error, pushToast]);
  useEffect(() => {
    if (!qr) return;
    if (!active || !status.data?.enabled || status.data.invitationExpiresAt !== qr.expiresAt) {
      setQr(null);
      return;
    }
    const timer = window.setTimeout(() => setQr(null), Math.max(0, qr.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [qr, status.data, active]);
  return (
    <RemotePanel
      data={status.data}
      qr={qr}
      busy={busy || status.isLoading}
      error={error || secret.error || status.error?.message || null}
      onToggle={(enabled) =>
        void act(async () => {
          setQr(null);
          await toggle.mutateAsync({ enabled });
        })
      }
      onLogin={() => void act(() => login.mutateAsync())}
      onTailscale={(enabled) =>
        void act(async () => {
          setQr(null);
          await tailscale.mutateAsync({ enabled });
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
          // 不把入网 Key 和二维码留在 React Query mutation cache 中。
          const result = await client.remote.invite.mutate(bootstrap);
          const fresh = await status.refetch();
          if (fresh.data?.invitationExpiresAt === result.expiresAt) setQr(result);
        })
      }
      onReview={(id) => useRemotePairingReview.setState({ id })}
      onRevoke={(id) => void act(() => revoke.mutateAsync({ id }))}
      onCopy={() => void secret.copy(async () => qr?.pairingURL ?? '')}
      accounts={accounts.data}
      accountError={accounts.error?.message}
      onAccountAccess={(id, configIds) => void act(() => grant.mutateAsync({ id, configIds }))}
    />
  );
}
