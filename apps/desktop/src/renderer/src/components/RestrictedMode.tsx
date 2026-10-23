import { useEffect, useId, useRef, useState } from 'react';
import { KeyRound, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { restrictionReasons } from '../lib/restrictedMode';
import { useRestrictedMode, type AuthorizationRequest } from '../state/restrictedMode';
import { useViewState } from '../state/view';
import { useToast } from './Toast';
import '../styles/restricted-mode.css';

function ipc() {
  return window.electron?.ipcRenderer;
}

/** 保留主进程的 token、取消与超时语义，只将授权入口改为非阻塞详情。 */
function useAuthorizationBridge() {
  useEffect(() => {
    const bridge = ipc();
    if (!bridge) return;
    const off = [
      bridge.on('elev:request-password', (_event, raw) => {
        const payload = raw as { token?: number; title?: string; message?: string };
        if (typeof payload?.token !== 'number') return;
        useRestrictedMode.getState().request({
          kind: 'password',
          token: payload.token,
          title: payload.title ?? '管理员授权',
          message: payload.message ?? '请输入管理员密码以继续。',
        });
      }),
      bridge.on('attach:confirm-hint', (_event, raw) => {
        const token = (raw as { token?: number })?.token;
        if (typeof token !== 'number') return;
        useRestrictedMode.getState().request({
          kind: 'ptrace',
          token,
          title: '读取 QQ 内存',
          message:
            'Linux 的 ptrace 保护阻止读取 QQ 内存。可输入管理员密码临时提权，或调整系统保护后重试。临时提权不会永久关闭保护。',
        });
      }),
      ...(['password', 'ptrace'] as const).map((kind) =>
        bridge.on(
          kind === 'password' ? 'elev:cancel-password' : 'attach:cancel-hint',
          (_event, raw) => {
            const token = (raw as { token?: number })?.token;
            if (typeof token === 'number') useRestrictedMode.getState().remove(kind, token);
          },
        ),
      ),
    ];
    return () => {
      for (const remove of off) remove?.();
    };
  }, []);
}

export function RestrictedModeIndicator({ startup = false }: { startup?: boolean }) {
  const reasons = useRestrictedMode((s) => s.reasons);
  const requests = useRestrictedMode((s) => s.requests);
  const open = useRestrictedMode((s) => s.open);
  if (!reasons.length && !requests.length) return null;
  return (
    <button
      type="button"
      className={`weq-restricted-indicator${startup ? ' is-startup' : ''}`}
      title="受限模式"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => useRestrictedMode.getState().setOpen(!open)}
    >
      <ShieldAlert size={15} aria-hidden />
      受限模式
    </button>
  );
}

function AuthorizationForm({ request }: { request: AuthorizationRequest }) {
  const [password, setPassword] = useState('');
  const id = useId();
  function respond(cancel = false, retry = false) {
    if (request.kind === 'password')
      ipc()?.send('elev:respond-password', {
        token: request.token,
        password: cancel ? null : password,
      });
    else
      ipc()?.send('attach:respond-hint', {
        token: request.token,
        choice: cancel ? 'cancel' : retry ? 'retry' : 'skip',
        password: cancel ? '' : password,
      });
    setPassword('');
    useRestrictedMode.getState().remove(request.kind, request.token);
  }
  return (
    <form
      className="weq-restricted-auth"
      onSubmit={(event) => {
        event.preventDefault();
        if (password) respond();
      }}
    >
      <h3>待提权：{request.title}</h3>
      <p>{request.message}</p>
      <label htmlFor={id}>管理员密码</label>
      <input
        id={id}
        type="password"
        value={password}
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="weq-restricted-actions">
        <button type="submit" className="weq-set-btn" disabled={!password}>
          <KeyRound size={14} />
          提权
        </button>
        {request.kind === 'ptrace' && (
          <button type="button" className="weq-set-btn" onClick={() => respond(false, true)}>
            <RefreshCw size={14} />
            重试免密读取
          </button>
        )}
        <button type="button" className="weq-set-btn" onClick={() => respond(true)}>
          取消本次授权
        </button>
      </div>
    </form>
  );
}

export function RestrictedModeHost() {
  useAuthorizationBridge();
  const uin = useViewState((s) => s.openedUin);
  const view = useViewState((s) => s.view);
  const active = view === 'main' && Boolean(uin);
  const reasons = useRestrictedMode((s) => s.reasons);
  const requests = useRestrictedMode((s) => s.requests);
  const open = useRestrictedMode((s) => s.open);
  const panel = useRef<HTMLElement>(null);
  const previous = useRef('');
  const recoveryPending = useRef(false);
  const notice = useRef<number | undefined>(undefined);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!active) return;
    const subscription = client.account.onOnlineCredentialsReady.subscribe(undefined, {
      onData: () => {
        // 刷新共享查询，让发送按钮等在线入口与受限提示一起恢复。
        void utils.account.getGroupAlbumAccessState.invalidate();
      },
    });
    return () => subscription.unsubscribe();
  }, [active, uin, utils]);
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled: active,
    refetchInterval: 5000,
    staleTime: 4000,
    refetchOnWindowFocus: true,
  });
  // 由运行 QQ 的宿主判断系统；Web 客户端的操作系统不能代表宿主。
  const sip = trpc.bootstrap.sipEnabled.useQuery(undefined, { staleTime: 60_000 });
  const online = trpc.bootstrap.probeOnline.useQuery(undefined, {
    enabled: !active,
    refetchInterval: 5000,
  });
  useEffect(() => {
    const next = active
      ? restrictionReasons({ access: access.data, sipEnabled: sip.data, failed: access.isError })
      : restrictionReasons({
          access:
            online.data?.count === 0
              ? {
                  qqOnline: false,
                  attachEnabled: true,
                  hasA2: false,
                  hasD2: false,
                  hasD2Key: false,
                  hasGuid: false,
                }
              : undefined,
          failed: online.isError,
        });
    useRestrictedMode.getState().setReasons(next);
  }, [active, uin, access.data, access.isError, sip.data, online.data, online.isError]);
  const signature = [
    ...reasons.map((r) => r.code),
    ...(requests.length ? ['authorization'] : []),
  ].join(',');
  const fullModeConfirmed = active
    ? Boolean(
        access.data &&
          !access.isError &&
          restrictionReasons({ access: access.data, sipEnabled: sip.data }).length === 0,
      )
    : Boolean(online.data && !online.isError && online.data.count > 0);
  useEffect(() => {
    if (signature) recoveryPending.current = true;
    if (signature && signature !== previous.current) {
      const toast = useToast.getState();
      if (notice.current !== undefined) toast.dismiss(notice.current);
      notice.current = toast.push({
        tone: 'warning',
        title: `已进入受限模式：${requests.length ? '待提权' : reasons.map((r) => r.title).join('、')}`,
        action: {
          label: '查看受限模式详情',
          run: () => {
            if (
              useRestrictedMode.getState().reasons.length ||
              useRestrictedMode.getState().requests.length
            )
              useRestrictedMode.getState().setOpen(true);
          },
        },
      });
    }
    if (!signature) {
      useRestrictedMode.getState().setOpen(false);
      if (notice.current !== undefined) useToast.getState().dismiss(notice.current);
      notice.current = undefined;
      if (recoveryPending.current && fullModeConfirmed) {
        useToast.getState().push({ tone: 'success', title: '已恢复完整模式' });
        recoveryPending.current = false;
      }
    }
    previous.current = signature;
  }, [signature, reasons, requests, fullModeConfirmed]);
  useEffect(() => {
    setError('');
    useRestrictedMode.getState().setOpen(false);
  }, [uin]);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useRestrictedMode.getState().setOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !panel.current?.contains(event.target) &&
        !event.target.closest('.weq-restricted-indicator, .weq-toast')
      )
        useRestrictedMode.getState().setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', outside);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [open]);
  async function refresh(enable = false) {
    setBusy(true);
    setError('');
    try {
      if (enable) await client.bootstrap.setAutoAttachQq.mutate({ enabled: true });
      if (active && (enable || (access.data?.qqOnline && access.data.attachEnabled))) {
        const refreshed = await client.account.refreshRkeys.mutate();
        if (!refreshed) setError('尚未恢复完整功能，请检查 QQ 登录状态及授权请求后重试。');
      }
      await Promise.all([active ? access.refetch() : online.refetch(), sip.refetch()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!active && <RestrictedModeIndicator startup />}
      {open && signature && (
        <section
          ref={panel}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className="weq-restricted-panel"
        >
          <header>
            <h2 id={titleId}>
              <ShieldAlert size={18} />
              受限模式
            </h2>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="关闭详情"
              aria-label="关闭详情"
              onClick={() => useRestrictedMode.getState().setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <div className="weq-restricted-body">
            {reasons.map((reason) => (
              <div className="weq-restricted-reason" key={reason.code}>
                <h3>{reason.title}</h3>
                <p>{reason.guidance}</p>
              </div>
            ))}
            {requests.map((request) => (
              <AuthorizationForm key={`${request.kind}:${request.token}`} request={request} />
            ))}
            {error && <p role="alert">{error}</p>}
            <div className="weq-restricted-actions">
              <button
                type="button"
                className="weq-set-btn"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                {busy ? '正在检查' : '重新检查'}
              </button>
              {reasons.some((r) => r.code === 'disabled') && (
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={busy}
                  onClick={() => void refresh(true)}
                >
                  <KeyRound size={14} />
                  启用完整功能
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
