import { useEffect, useId, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, Play, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { restrictionReasons } from '../lib/restrictedMode';
import { useRestrictedMode, type AuthorizationRequest } from '../state/restrictedMode';
import { useViewState } from '../state/view';
import { useToast } from './Toast';
import '../styles/restricted-mode.css';

const NOTICE_KEY = 'restricted-mode';

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

export function RestrictedModeIndicator({
  startup = false,
  persistent = false,
}: {
  startup?: boolean;
  persistent?: boolean;
}) {
  const reasons = useRestrictedMode((s) => s.reasons);
  const requests = useRestrictedMode((s) => s.requests);
  const open = useRestrictedMode((s) => s.open);
  const entering = useRestrictedMode((s) => s.enteringSince !== null && s.requests.length === 0);
  const awaitingAuthorization = requests.length > 0;
  const title = awaitingAuthorization ? '待提权' : entering ? '正在启用完整功能' : '受限模式';
  const visible = Boolean(reasons.length || requests.length || entering);
  if (!visible && !persistent) return null;
  return (
    <button
      type="button"
      className={`weq-restricted-indicator${startup ? ' is-startup' : ''}${entering ? ' is-entering' : ''}`}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={entering}
      aria-hidden={!visible || undefined}
      disabled={!visible}
      tabIndex={visible ? undefined : -1}
      onClick={() => useRestrictedMode.getState().setOpen(!open)}
    >
      {awaitingAuthorization ? (
        <KeyRound size={15} aria-hidden />
      ) : entering ? (
        <LoaderCircle size={15} className="weq-restricted-progress-icon" aria-hidden />
      ) : (
        <ShieldAlert size={15} aria-hidden />
      )}
      <span>{title}</span>
    </button>
  );
}

export function cancelAuthorizationRequest(request: AuthorizationRequest): void {
  if (request.kind === 'password')
    ipc()?.send('elev:respond-password', { token: request.token, password: null });
  else ipc()?.send('attach:respond-hint', { token: request.token, choice: 'cancel', password: '' });
  useRestrictedMode.getState().remove(request.kind, request.token);
}

export function AuthorizationForm({ request }: { request: AuthorizationRequest }) {
  const [password, setPassword] = useState('');
  const id = useId();
  function respond(cancel = false, retry = false) {
    const view = useViewState.getState();
    if (!cancel && view.view === 'main' && view.openedUin)
      useRestrictedMode.getState().beginEntering();
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
  const enteringSince = useRestrictedMode((s) => s.enteringSince);
  const awaitingAuthorization = requests.length > 0;
  const entering = enteringSince !== null && !awaitingAuthorization;
  const previousUin = useRef(uin);
  const panel = useRef<HTMLElement>(null);
  const previous = useRef('');
  const recoveryPending = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
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
  const fullModeConfirmed = active
    ? Boolean(
        access.data &&
          !access.isError &&
          restrictionReasons({ access: access.data, sipEnabled: sip.data }).length === 0,
      )
    : Boolean(online.data && !online.isError && online.data.count > 0);
  useEffect(() => {
    if (!active) return;
    const blocked =
      !access.data?.qqOnline ||
      !access.data.attachEnabled ||
      access.isError ||
      restrictionReasons({ access: access.data, sipEnabled: sip.data }).some(
        (reason) => reason.code === 'sip',
      );
    if (access.data?.credentialsPending && !fullModeConfirmed && !blocked) {
      if (enteringSince === null && !requests.length) useRestrictedMode.getState().beginEntering();
      return;
    }
    // 提交授权后必须拿到新查询结果，不能用之前缓存的完整状态提前结束。
    const checkedAt = Math.max(access.dataUpdatedAt, access.errorUpdatedAt ?? 0);
    if (enteringSince !== null && !busy && !requests.length && checkedAt > enteringSince)
      useRestrictedMode.getState().endEntering();
  }, [
    active,
    access.data,
    access.isError,
    access.dataUpdatedAt,
    access.errorUpdatedAt,
    sip.data,
    fullModeConfirmed,
    enteringSince,
    busy,
    requests.length,
  ]);
  useEffect(() => {
    if (active && enteringSince !== null) void utils.account.getGroupAlbumAccessState.invalidate();
  }, [active, uin, enteringSince, utils]);
  const signature = [
    ...reasons.map((r) => r.code),
    ...(requests.length ? ['authorization'] : []),
    ...(entering ? ['entering'] : []),
  ].join(',');
  useEffect(() => {
    if (signature) recoveryPending.current = true;
    if (signature && signature !== previous.current) {
      const toast = useToast.getState();
      const message: Parameters<typeof toast.push>[0] = {
        key: NOTICE_KEY,
        tone: entering ? 'info' : 'warning',
        title: awaitingAuthorization
          ? '待提权：请完成管理员授权'
          : entering
            ? '正在启用完整功能'
            : `已进入受限模式：${reasons.map((r) => r.title).join('、')}`,
        loading: entering,
        durationKind: entering ? 'long' : 'failure',
        ...(entering ? { ttl: 0 } : {}),
        action: {
          label: entering ? '查看进入进度' : '查看受限模式详情',
          run: () => {
            if (
              useRestrictedMode.getState().reasons.length ||
              useRestrictedMode.getState().requests.length ||
              useRestrictedMode.getState().enteringSince !== null
            )
              useRestrictedMode.getState().setOpen(true);
          },
        },
      };
      toast.push(message);
    }
    if (!signature) {
      useRestrictedMode.getState().setOpen(false);
      useToast.getState().resolve(NOTICE_KEY);
      if (recoveryPending.current && fullModeConfirmed) {
        useToast.getState().push({ tone: 'success', title: '已启用完整功能' });
        recoveryPending.current = false;
      }
    }
    previous.current = signature;
  }, [signature, reasons, requests, fullModeConfirmed, entering, awaitingAuthorization]);
  useEffect(() => {
    if (previousUin.current !== uin) {
      previousUin.current = uin;
      useRestrictedMode.getState().endEntering();
    }
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
  async function startQq() {
    setLaunching(true);
    setError('');
    try {
      await client.bootstrap.launchQq.mutate();
      await (active ? access.refetch() : online.refetch());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }
  async function refresh(enable = false) {
    setBusy(true);
    setError('');
    if (active) useRestrictedMode.getState().beginEntering();
    try {
      if (enable) await client.bootstrap.setAutoAttachQq.mutate({ enabled: true });
      if (active && (enable || (access.data?.qqOnline && access.data.attachEnabled))) {
        const refreshed = await client.account.refreshRkeys.mutate();
        if (!refreshed) setError('尚未恢复完整功能，请检查 QQ 登录状态及授权请求后重试。');
      }
      await Promise.all([active ? access.refetch() : online.refetch(), sip.refetch()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      useRestrictedMode.getState().endEntering();
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
          className={`weq-restricted-panel${entering ? ' is-entering' : ''}`}
        >
          <header>
            <h2 id={titleId}>
              {awaitingAuthorization ? (
                <KeyRound size={18} />
              ) : entering ? (
                <LoaderCircle size={18} className="weq-restricted-progress-icon" />
              ) : (
                <ShieldAlert size={18} />
              )}
              {awaitingAuthorization ? '待提权' : entering ? '正在启用完整功能' : '受限模式'}
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
            {entering && <p role="status">正在准备在线会话，请稍候。</p>}
            {reasons
              .filter((reason) => !awaitingAuthorization || reason.code !== 'credentials')
              .map((reason) => (
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
              {reasons.some((reason) => reason.code === 'offline') && (
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={busy || launching}
                  aria-busy={launching}
                  onClick={() => void startQq()}
                >
                  {launching ? (
                    <LoaderCircle size={14} className="weq-restricted-progress-icon" />
                  ) : (
                    <Play size={14} />
                  )}
                  {launching ? '正在启动 QQ' : '启动 QQ'}
                </button>
              )}
              <button
                type="button"
                className="weq-set-btn"
                disabled={busy || launching}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                {busy ? '正在检查' : '重新检查'}
              </button>
              {reasons.some((r) => r.code === 'disabled') && (
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={busy || launching}
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
