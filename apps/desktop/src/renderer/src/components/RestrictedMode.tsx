import { useEffect, useId, useRef, useState } from 'react';
import {
  KeyRound,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  X,
  Zap,
} from 'lucide-react';
import { LongTermAuthorizationLink } from './LongTermAuthorizationLink';
import { LoadingIndicator } from './LoadingIndicator';
import { RestrictedQqAction } from './RestrictedQqAction';
import { QqProxyRecovery, QqProxySettingsLink } from './QqProxyConnection';
import { useQqProxyStatus } from '../hooks/useQqProxyStatus';
import {
  QQ_PROXY_CONNECTING,
  QQ_PROXY_WAITING,
  qqProxySetupGuide,
} from './QqProxyConnection.shared';
import { client, trpc } from '../trpc/client';
import {
  restrictionReasons,
  startupRestrictionReasons,
  dataAccessRestriction,
  type Restriction,
} from '../lib/restrictedMode';
import { IS_MAC } from '../lib/target.shared';
import { QqDataAccessNotice } from '../views/bootstrap/QqDataAccessNotice';
import { useRestrictedMode, type AuthorizationRequest } from '../state/restrictedMode';
import { useViewState } from '../state/view';
import { useToastApi } from './Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { useOverlayLayer } from '../lib/overlayStack';
import { topSurface } from '../lib/surfaceEscape';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import '../styles/restricted-mode.css';
import { ipc, QQ_STATUS_DETAILS_ID } from './RestrictedMode.shared';

const NOTICE_KEY = 'restricted-mode';

function nextOnlineStep(
  reasons: Restriction[],
  awaitingAuthorization: boolean,
  entering: boolean,
  showOnline: boolean,
) {
  const dataAccess = reasons.find((reason) => reason.code === 'data-access');
  if (dataAccess) return dataAccess;
  if (!showOnline) return awaitingAuthorization ? 'authorization' : undefined;
  const prerequisite =
    reasons.find((reason) => reason.code === 'disabled') ??
    reasons.find((reason) => reason.code === 'offline');
  if (prerequisite) return prerequisite;
  if (awaitingAuthorization) return 'authorization';
  if (entering) return 'entering';
  return reasons[0];
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

export function RestrictedModeIndicator({ persistent = false }: { persistent?: boolean }) {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const reasons = useRestrictedMode((s) => s.reasons);
  const requests = useRestrictedMode((s) => s.requests);
  const open = useRestrictedMode((s) => s.open);
  const authorizationIssue = reasons.some((reason) => reason.code === 'authorization');
  const entering =
    useRestrictedMode((s) => s.enteringSince !== null && s.requests.length === 0) &&
    !authorizationIssue;
  const awaitingAuthorization = requests.length > 0;
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, { enabled: false });
  const proxy = useQqProxyStatus(false, access);
  const onlineEnabled = settings.data?.autoAttachQq === true;
  const onlineStep = nextOnlineStep(reasons, awaitingAuthorization, entering, onlineEnabled);
  const onlineAttention = Boolean(onlineStep);
  const proxyAttention = onlineEnabled && proxy.needsAttention;
  const proxyConnecting = proxyAttention && !proxy.isError && proxy.current?.connecting;
  const proxyWaiting = proxyAttention && proxy.waiting;
  const inProgress =
    onlineStep === 'entering' || (!onlineAttention && Boolean(proxyWaiting || proxyConnecting));
  const title =
    onlineStep === 'authorization'
      ? '待提权'
      : onlineStep === 'entering'
        ? '正在启用 QQ 在线能力'
        : onlineAttention
          ? onlineStep?.code === 'data-access'
            ? onlineStep.title
            : '在线能力受限'
          : proxy.isError
            ? 'QQ 代理状态待确认'
            : proxyConnecting
              ? QQ_PROXY_CONNECTING
              : proxyWaiting
                ? QQ_PROXY_WAITING
                : 'QQ 代理未连接';
  const visible =
    settings.data?.qqStatusIndicatorEnabled !== false && (onlineAttention || proxyAttention);
  if (!visible && !persistent) return null;
  return (
    <button
      type="button"
      className={`weq-restricted-indicator${inProgress ? ' is-entering' : ''}`}
      data-restricted-mode-trigger
      title={title}
      aria-label={title}
      aria-controls={open ? QQ_STATUS_DETAILS_ID : undefined}
      aria-haspopup="dialog"
      aria-expanded={visible && open}
      aria-busy={inProgress}
      aria-hidden={!visible || undefined}
      disabled={!visible}
      tabIndex={visible ? undefined : -1}
      onClick={() => useRestrictedMode.getState().setOpen(!open)}
    >
      {onlineStep === 'authorization' ? (
        <KeyRound size={15} aria-hidden />
      ) : inProgress ? (
        <LoaderCircle size={15} className="weq-restricted-progress-icon" aria-hidden />
      ) : !onlineAttention ? (
        <Network size={15} aria-hidden />
      ) : (
        <ShieldAlert size={15} aria-hidden />
      )}
      <span>{title}</span>
    </button>
  );
}

export function AuthorizationForm({
  request,
  onOpenLongTermAuthorization,
  showLongTermAuthorization = true,
}: {
  request: AuthorizationRequest;
  onOpenLongTermAuthorization?: () => void;
  showLongTermAuthorization?: boolean;
}) {
  const [password, setPassword] = useState('');
  const id = useId();
  function respond(cancel = false, retry = false) {
    if (
      !useRestrictedMode
        .getState()
        .requests.some((item) => item.kind === request.kind && item.token === request.token)
    ) {
      setPassword('');
      return;
    }
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
        <button type="submit" className="weq-set-btn weq-set-btn-primary" disabled={!password}>
          <KeyRound size={14} />
          提权
        </button>
        {request.kind === 'ptrace' && (
          <button type="button" className="weq-set-btn" onClick={() => respond(false, true)}>
            <RefreshCw size={14} />
            重试免密读取
          </button>
        )}
        {showLongTermAuthorization && !request.title.includes('长期授权') && (
          <LongTermAuthorizationLink
            beforeNavigate={() => {
              respond(true);
              useRestrictedMode.getState().setOpen(false);
              onOpenLongTermAuthorization?.();
            }}
          />
        )}
      </div>
    </form>
  );
}

export function RestrictedModeHost() {
  const notificationToast = useToastApi();
  useAuthorizationBridge();
  const uin = useViewState((s) => s.openedUin);
  const view = useViewState((s) => s.view);
  const active = view === 'main' && Boolean(uin);
  const reasons = useRestrictedMode((s) => s.reasons);
  const reasonSource = useRestrictedMode((s) => s.reasonSource);
  const requests = useRestrictedMode((s) => s.requests);
  const open = useRestrictedMode((s) => s.open);
  const settingsSection = useRestrictedMode((s) => s.settingsSection);
  const enteringSince = useRestrictedMode((s) => s.enteringSince);
  const enteringManually = useRestrictedMode((s) => s.enteringManually);
  const awaitingAuthorization = requests.length > 0;
  const authorizationIssue = reasons.some((reason) => reason.code === 'authorization');
  const entering = enteringSince !== null && !awaitingAuthorization && !authorizationIssue;
  const previousUin = useRef(uin);
  const panel = useRef<HTMLElement>(null);
  const previous = useRef('');
  const recoveryPending = useRef(false);
  const fullModeSeen = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [loginRequested, setLoginRequested] = useState<string | null>(null);
  const refreshAfterLogin = useRef<() => Promise<void>>(async () => {});
  const [error, setError] = useState('');
  const [dataRetried, setDataRetried] = useState(false);
  const operation = useRef(0);
  const operationBusy = useRef(false);
  const launchOperation = useRef(0);
  const launchPending = useRef(false);
  const utils = trpc.useUtils();
  const globalSettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const onlineEnabled = globalSettings.data?.autoAttachQq === true;
  const onlineDisabled = globalSettings.data?.autoAttachQq === false;
  const onlineStep = nextOnlineStep(
    reasons,
    awaitingAuthorization,
    entering,
    onlineEnabled || settingsSection === 'online',
  );
  const reason = typeof onlineStep === 'object' ? onlineStep : undefined;
  const authorizationRequest = onlineStep === 'authorization' ? requests[0] : undefined;
  useEffect(() => {
    if (onlineDisabled) useRestrictedMode.getState().endEntering();
  }, [onlineDisabled]);
  const runtimeNotice = globalSettings.data?.notificationEvents?.runtime;
  const passiveNotice = runtimeNotice
    ? runtimeNotice.banner || runtimeNotice.system
    : globalSettings.data?.restrictedModeBannerEnabled !== false;
  const checkInterval = open ? 2000 : 5000;
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
    refetchInterval: checkInterval,
    refetchIntervalInBackground: open,
    staleTime: 4000,
    refetchOnWindowFocus: true,
  });
  // 签名器降级（VM 定位失败 / 版本变了要重扫）后，签名会退回完整签名函数：
  // 功能还能用，但慢，而且只发 SecSign。这种「能用但退化了」的状态必须明确
  // 告诉用户，不能等他们去翻诊断页。只在 QQ 在线能力确认后提示一次。
  const signer = trpc.bootstrap.signerStatus.useQuery(undefined, {
    enabled: active,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const signerDegraded = Boolean(
    signer.data &&
      (signer.data.state === 'stale' ||
        signer.data.warmup?.outcome === 'failed' ||
        (signer.data.state === 'hit' &&
          signer.data.signCoreRva !== null &&
          signer.data.vmRva === null)),
  );
  const signerWarned = useRef(false);
  const accessSource = access.data?.source;
  const accessMatches = !accessSource || accessSource.expectedAccountUin === uin;
  const proxyStatus = useQqProxyStatus(
    active && (open || (onlineEnabled && globalSettings.data?.qqStatusIndicatorEnabled !== false)),
    access,
  );
  const proxy = active && accessMatches ? proxyStatus.current : undefined;
  const proxyAttention = Boolean(proxy && proxyStatus.needsAttention);
  const proxyConnecting = proxyAttention && !proxyStatus.isError && proxy?.connecting === true;
  const canConfigureProxy =
    proxyAttention && !proxyStatus.isError && proxy?.running === true && !proxyConnecting;
  const sourceKey = JSON.stringify([
    active,
    uin,
    accessSource?.expectedAccountUin,
    accessSource?.expectedAccountConfigId,
  ]);
  const currentSource = useRef(sourceKey);
  const previousSource = useRef(sourceKey);
  currentSource.current = sourceKey;
  useEffect(() => {
    if (previousSource.current === sourceKey) return;
    previousSource.current = sourceKey;
    operation.current += 1;
    launchOperation.current += 1;
    operationBusy.current = false;
    launchPending.current = false;
    setBusy(false);
    setLaunching(false);
    setLoginRequested(null);
    setError('');
    setDataRetried(false);
    previous.current = '';
    recoveryPending.current = false;
    fullModeSeen.current = false;
    notificationToast.resolve(NOTICE_KEY);
    useRestrictedMode.getState().setOpen(false);
    useRestrictedMode.getState().endEntering();
  }, [sourceKey, notificationToast]);
  useEffect(
    () => () => {
      operation.current += 1;
      launchOperation.current += 1;
    },
    [],
  );
  // 由运行 QQ 的宿主判断系统；Web 客户端的操作系统不能代表宿主。
  const sip = trpc.bootstrap.sipEnabled.useQuery(undefined, { staleTime: 60_000 });
  const showDebugCopy =
    IS_MAC &&
    sip.data === true &&
    reason !== undefined &&
    ['sip', 'offline', 'credentials'].includes(reason.code);
  const offline = reason?.code === 'offline';
  const sipLimited = reason?.code === 'sip';
  const currentAccountPid =
    accessMatches && !access.isError && access.data?.qqOnline ? access.data.qqPid : null;
  // 副本入口负责后台刷新，此处只订阅同一份进程快照来合并代理与在线能力的操作。
  const debugCopy = trpc.bootstrap.qqDebugCopyStatus.useQuery(undefined, { enabled: false });
  const signedInToCopy =
    currentAccountPid != null && debugCopy.data?.runningPids.includes(currentAccountPid);
  const needsDebugQq = offline || (sipLimited && !signedInToCopy);
  const checkQqProcess = open && offline && !showDebugCopy && !canConfigureProxy;
  const qqProcess = trpc.bootstrap.getQqProcessState.useQuery(undefined, {
    enabled: checkQqProcess,
    staleTime: 0,
    refetchInterval: checkQqProcess ? 3000 : false,
    retry: false,
  });
  const qqRunning = !qqProcess.isError && qqProcess.data?.running === true;
  useEffect(() => {
    if (
      loginRequested !== sourceKey ||
      !active ||
      !accessMatches ||
      !access.data?.qqOnline ||
      !signedInToCopy ||
      busy ||
      requests.length
    )
      return;
    setLoginRequested(null);
    if (access.data.attachEnabled) void refreshAfterLogin.current();
  }, [
    loginRequested,
    sourceKey,
    active,
    accessMatches,
    access.data?.qqOnline,
    access.data?.attachEnabled,
    signedInToCopy,
    busy,
    requests.length,
  ]);
  const online = trpc.bootstrap.probeOnline.useQuery(undefined, {
    enabled: !active,
    refetchInterval: checkInterval,
    refetchIntervalInBackground: open,
  });
  const dataAccess = trpc.bootstrap.qqDataAccess.useQuery(undefined, {
    enabled: IS_MAC,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 5000,
    refetchInterval: open ? checkInterval : false,
    refetchIntervalInBackground: open,
  });
  const dataStatus = dataAccess.data?.status;
  const diskBlocked = dataAccess.isError || dataStatus === 'denied' || dataStatus === 'error';
  const previousDiskBlocked = useRef(diskBlocked);
  useEffect(() => {
    const restored =
      previousDiskBlocked.current &&
      !diskBlocked &&
      (dataStatus === 'readable' || dataStatus === 'not-found');
    previousDiskBlocked.current = diskBlocked;
    if (!restored) return;
    void Promise.all([
      utils.bootstrap.listAccounts.invalidate(),
      utils.bootstrap.listAccountConfigs.invalidate(),
      utils.bootstrap.describeInstall.invalidate(),
    ]);
  }, [diskBlocked, dataStatus, utils]);
  useEffect(() => {
    let next = active
      ? restrictionReasons({
          access: accessMatches ? access.data : undefined,
          sipEnabled: sip.data,
          failed: access.isError || !accessMatches,
        })
      : startupRestrictionReasons({
          probe: online.data,
          sipEnabled: sip.data,
          dataStatus: dataAccess.data?.status,
          failed: online.isError,
        });
    if (active) {
      const disk = dataAccessRestriction(dataAccess.data?.status);
      if (disk.length) {
        // 数据目录不可读时，失败的账号归属探测不能证明 QQ 已离线。
        next = next.filter((reason) => reason.code !== 'offline');
        next.unshift(...disk);
      }
    }
    if (dataAccess.isError && !next.some((reason) => reason.code === 'data-access'))
      next.unshift(...dataAccessRestriction('error'));
    useRestrictedMode.getState().setReasons(next, sourceKey);
  }, [
    active,
    uin,
    access.data,
    access.isError,
    accessMatches,
    sip.data,
    online.data,
    online.isError,
    dataAccess.data,
    dataAccess.isError,
    sourceKey,
  ]);
  const fullModeConfirmed = active
    ? Boolean(
        accessMatches &&
          access.data &&
          !access.isError &&
          !dataAccess.isError &&
          restrictionReasons({ access: access.data, sipEnabled: sip.data }).length === 0 &&
          dataAccessRestriction(dataAccess.data?.status).length === 0,
      )
    : false;
  useEffect(() => {
    if (!active) return;
    const blocked =
      onlineDisabled ||
      !accessMatches ||
      !access.data?.qqOnline ||
      !access.data.attachEnabled ||
      access.isError ||
      dataAccessRestriction(dataAccess.data?.status).length > 0 ||
      restrictionReasons({ access: access.data, sipEnabled: sip.data }).some(
        (reason) => reason.code === 'sip',
      );
    if (access.data?.credentialsPending && !fullModeConfirmed && !blocked) {
      if (enteringSince === null && !requests.length)
        useRestrictedMode.getState().beginEntering(false);
      return;
    }
    // 提交授权后必须拿到新查询结果，不能用之前缓存的完整状态提前结束。
    const checkedAt = Math.max(access.dataUpdatedAt, access.errorUpdatedAt ?? 0);
    if (enteringSince !== null && !busy && !requests.length && checkedAt > enteringSince)
      useRestrictedMode.getState().endEntering();
  }, [
    active,
    onlineDisabled,
    accessMatches,
    access.data,
    access.isError,
    access.dataUpdatedAt,
    access.errorUpdatedAt,
    dataAccess.data,
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
  const showProxy =
    !onlineStep && ((onlineEnabled && proxyAttention) || settingsSection === 'proxy');
  const showOnline = Boolean(onlineStep) || (!showProxy && settingsSection === 'online');
  const showDetails = open && (showOnline || showProxy);
  useEffect(() => {
    if (open && !showOnline && !showProxy) useRestrictedMode.getState().setOpen(false);
  }, [open, showOnline, showProxy]);
  const layer = useOverlayLayer(showDetails);
  useEffect(() => {
    if (reasonSource !== sourceKey) return;
    // 能力查询可能早于共享设置刷新。主动启用则会在凭据查询追上前先进入流程。
    if (
      onlineDisabled ||
      (!enteringManually && reasons.some((reason) => reason.code === 'disabled'))
    ) {
      previous.current = '';
      fullModeSeen.current = false;
      recoveryPending.current = false;
      notificationToast.resolve(NOTICE_KEY);
      return;
    }
    const manualNotice = enteringManually || recoveryPending.current;
    const activeNotice = manualNotice && (entering || awaitingAuthorization);
    if (!activeNotice && !passiveNotice) notificationToast.resolve(NOTICE_KEY);
    if (enteringManually) recoveryPending.current = true;
    // 启动自动尝试只更新标题栏；确认正常运行后才提醒降级，手动启用单独回执。
    const notify = manualNotice || (onlineEnabled && fullModeSeen.current && passiveNotice);
    const noticeSignature = `${signature}:${enteringManually}`;
    if (signature && noticeSignature !== previous.current && notify) {
      const toast = notificationToast;
      const message: Parameters<typeof toast.push>[0] = {
        key: NOTICE_KEY,
        event: awaitingAuthorization ? 'request' : entering ? 'progress' : 'runtime',
        tone: entering ? 'info' : 'warning',
        title: awaitingAuthorization
          ? '待提权'
          : entering
            ? '正在启用 QQ 在线能力'
            : 'QQ 在线能力受限',
        summary: awaitingAuthorization
          ? '请完成管理员授权后继续启用'
          : entering
            ? undefined
            : reasons.map((reason) => reason.title).join('、'),
        loading: entering,
        durationKind: entering ? 'long' : 'failure',
        ...(entering ? { ttl: 0 } : {}),
        action: {
          label: awaitingAuthorization
            ? '查看授权请求'
            : entering
              ? '查看启用进度'
              : '查看 QQ 功能状态',
          run: () => {
            if (currentSource.current !== sourceKey) return;
            const state = useRestrictedMode.getState();
            if (state.reasons.length || state.requests.length || state.enteringSince !== null)
              state.setOpen(true);
          },
        },
      };
      toast.push(message);
    }
    if (signature && !enteringManually && !entering && !awaitingAuthorization && !fullModeConfirmed)
      recoveryPending.current = false;
    if (!signature) {
      if (onlineEnabled && fullModeConfirmed) fullModeSeen.current = true;
      notificationToast.resolve(NOTICE_KEY);
      if (recoveryPending.current && fullModeConfirmed) {
        notificationToast.push({ tone: 'success', title: '已启用 QQ 在线能力' });
        recoveryPending.current = false;
        // 刚刚确认 QQ 在线能力：顺手把签名器降级的情况说清楚。
        if (signerDegraded && !signerWarned.current) {
          signerWarned.current = true;
          notificationToast.push({
            key: 'signer-degraded',
            event: 'runtime',
            tone: 'warning',
            title: 'QQ 在线能力已启用，签名方式已切换',
            summary: '暂时使用兼容方式完成 QQ 在线操作',
            source: notificationSource({
              kind: 'app',
              target: { kind: 'setting', section: 'diagnostics', settingId: 'signer-status' },
            }),
            detail: signer.data
              ? `sign core RVA ${signer.data.signCoreRva === null ? '未定位' : `0x${signer.data.signCoreRva.toString(16)}`}，VM ${signer.data.vmRva === null ? '未定位' : `0x${signer.data.vmRva.toString(16)}`}。QQ 更新或 wrapper.node 被替换后需要重新扫描；可在「设置 → QQ → 高级工具 → 签名器」里手动重扫。`
              : undefined,
          });
        }
      }
    }
    previous.current = noticeSignature;
  }, [
    signature,
    reasons,
    requests,
    fullModeConfirmed,
    entering,
    enteringManually,
    awaitingAuthorization,
    passiveNotice,
    onlineEnabled,
    onlineDisabled,
    reasonSource,
    sourceKey,
    signerDegraded,
    signer.data,
    notificationToast,
  ]);
  useEffect(() => {
    if (previousUin.current !== uin) {
      previousUin.current = uin;
      useRestrictedMode.getState().endEntering();
    }
    setError('');
    useRestrictedMode.getState().setOpen(false);
    setDataRetried(false);
  }, [uin]);
  useEffect(() => {
    if (!showDetails) return;
    const before = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        topSurface(document) === panel.current
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        useRestrictedMode.getState().setOpen(false);
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        !event.defaultPrevented &&
        topSurface(document) === panel.current &&
        event.target instanceof Element &&
        !panel.current?.contains(event.target) &&
        !event.target.closest(
          `[data-restricted-mode-trigger], [aria-controls="${QQ_STATUS_DETAILS_ID}"], .weq-toast`,
        )
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
  }, [showDetails]);
  async function startQq() {
    if (launchPending.current) return;
    launchPending.current = true;
    const id = ++launchOperation.current,
      binding = sourceKey;
    const current = () => launchOperation.current === id && currentSource.current === binding;
    setLaunching(true);
    setError('');
    try {
      if (qqRunning) await client.bootstrap.launchQq.mutate({ newInstance: true });
      else await client.bootstrap.launchQq.mutate();
      if (!current()) return;
      await (active ? access.refetch() : online.refetch());
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) {
        launchPending.current = false;
        setLaunching(false);
      }
    }
  }
  async function refresh(enable = false) {
    if (operationBusy.current) return;
    const source = access.data?.source ? { ...access.data.source } : undefined;
    if (enable && (!active || !source || source.expectedAccountUin !== uin)) {
      setError('当前账号来源尚待确认，请稍后再启用 QQ 在线能力。');
      return;
    }
    operationBusy.current = true;
    const id = ++operation.current;
    const binding = sourceKey;
    const current = () => operation.current === id && currentSource.current === binding;
    setBusy(true);
    setError('');
    if (active && (!enable || access.data?.qqOnline) && reason?.code !== 'data-access')
      useRestrictedMode.getState().beginEntering();
    try {
      const disk = IS_MAC ? await dataAccess.refetch() : null;
      if (!current()) return;
      if (disk?.error) throw disk.error;
      if (showDebugCopy) await utils.bootstrap.qqDebugCopyStatus.invalidate();
      if (!current()) return;
      if (disk) setDataRetried(true);
      const dataBlocked = disk && (disk.data?.status === 'denied' || disk.data?.status === 'error');
      if (disk && !dataBlocked) {
        await Promise.all([
          utils.bootstrap.listAccounts.invalidate(),
          utils.bootstrap.listAccountConfigs.invalidate(),
          utils.bootstrap.describeInstall.invalidate(),
        ]);
      }
      if (!current()) return;
      if (enable && source && !dataBlocked) {
        await client.account.requestFullMode.mutate(source);
        if (!current()) return;
        if (onlineDisabled) await globalSettings.refetch();
      }
      if (!current()) return;
      if (
        active &&
        !dataBlocked &&
        accessMatches &&
        access.data?.qqOnline &&
        (enable || access.data.attachEnabled)
      ) {
        const refreshed = await client.account.refreshRkeys.mutate(source);
        if (!current()) return;
        if (!refreshed) setError('尚未恢复 QQ 在线能力，请检查 QQ 登录状态及授权请求后重试。');
      }
      await Promise.all([active ? access.refetch() : online.refetch(), sip.refetch()]);
    } catch (e) {
      if (!current()) return;
      setError(e instanceof Error ? e.message : String(e));
      useRestrictedMode.getState().endEntering();
    } finally {
      if (current()) {
        operationBusy.current = false;
        setBusy(false);
      }
    }
  }
  refreshAfterLogin.current = refresh;
  async function afterDebugQqOpened() {
    if (currentSource.current !== sourceKey) return;
    if (active) setLoginRequested(sourceKey);
    await (active ? access.refetch() : online.refetch());
  }
  const canRetryCredentials = accessMatches && reason?.code === 'credentials';
  const proxyLogin = offline && canConfigureProxy && proxy;
  const proxyImpact = [
    proxy?.uses?.sync && '本人消息与已读同步',
    proxy?.uses?.liveMessages && '代理实时更新',
    proxy?.uses?.antiRecall && '代理防撤回',
  ]
    .filter(Boolean)
    .join('、');
  const closeDetails = () => useRestrictedMode.getState().setOpen(false);

  function refreshProxyAndOnline() {
    void proxyStatus.refetch();
    if (offline) void (active ? access.refetch() : online.refetch());
  }

  const onlineSettings = settingsSection !== 'online' && active && (
    <button
      type="button"
      className="weq-set-btn"
      disabled={busy || launching || entering}
      onClick={() => {
        closeDetails();
        requestOpenSettings('qqOnlineCapability');
      }}
    >
      <Settings size={14} aria-hidden />
      在线能力设置
    </button>
  );
  const proxySettings = settingsSection !== 'proxy' && (
    <QqProxySettingsLink beforeNavigate={closeDetails}>代理设置</QqProxySettingsLink>
  );
  const actions = showDebugCopy ? (
    <RestrictedQqAction
      key={sourceKey}
      needsQq={offline || sipLimited}
      hasCurrentAccount={active}
      currentAccountPid={currentAccountPid}
      busy={busy || entering}
      onOpened={async () => {
        if (proxyLogin) void proxyStatus.refetch();
        await afterDebugQqOpened();
      }}
      allowSwitch={!canConfigureProxy || needsDebugQq}
      onEnable={() => refresh(true)}
      onRetryCredentials={canRetryCredentials || sipLimited ? () => refresh() : undefined}
    >
      {onlineSettings}
    </RestrictedQqAction>
  ) : proxyLogin ? (
    <QqProxyRecovery key={sourceKey} onLaunch={refreshProxyAndOnline} needsCurrentLogin>
      {onlineSettings}
    </QqProxyRecovery>
  ) : (
    <div className="weq-restricted-actions">
      {reason?.code === 'authorization' && (
        <LongTermAuthorizationLink beforeNavigate={closeDetails} />
      )}
      {offline && (
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          disabled={busy || launching}
          aria-busy={launching}
          onClick={() => void startQq()}
        >
          {launching ? (
            <LoaderCircle size={14} className="weq-restricted-progress-icon" />
          ) : (
            <Play size={14} />
          )}
          {launching
            ? '正在打开 QQ'
            : qqRunning
              ? active
                ? '登录当前账号'
                : '打开 QQ 登录窗口'
              : '打开 QQ'}
        </button>
      )}
      {canRetryCredentials && (
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || launching}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          {busy ? '正在获取凭据' : '重试获取在线凭据'}
        </button>
      )}
      {reason?.code === 'disabled' && (
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          disabled={busy || launching}
          onClick={() => void refresh(true)}
        >
          <KeyRound size={14} />
          启用 QQ 在线能力
        </button>
      )}
      {onlineSettings}
    </div>
  );
  const proxyLabel = proxyStatus.isError
    ? 'QQ 代理状态待确认'
    : !proxy
      ? '正在检查 QQ 代理连接'
      : proxy.connected
        ? '已连接'
        : !proxy.enabled
          ? '已关闭'
          : !proxy.connectionExpected
            ? '当前账号无需连接代理'
            : proxyConnecting
              ? QQ_PROXY_CONNECTING
              : proxyStatus.waiting
                ? QQ_PROXY_WAITING
                : proxy.running
                  ? 'QQ 代理未连接'
                  : 'QQ 代理未运行';

  return (
    showDetails && (
      <section
        id={QQ_STATUS_DETAILS_ID}
        ref={panel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className="weq-restricted-panel"
        style={{ zIndex: layer }}
      >
        <header>
          <h2 id={titleId}>QQ 功能状态</h2>
          <button
            type="button"
            className="weq-set-iconbtn"
            title="关闭详情"
            aria-label="关闭详情"
            onClick={closeDetails}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="weq-restricted-body">
          {showOnline && (
            <section aria-label="QQ 在线能力" className="weq-qq-status-section">
              <h3>
                <Zap size={15} aria-hidden /> QQ 在线能力
              </h3>
              {!onlineStep && (
                <p role="status">
                  {fullModeConfirmed
                    ? '当前账号的 QQ 在线能力已就绪。'
                    : active
                      ? '正在检查当前账号的 QQ 在线能力。'
                      : '打开 QQ 账号后，WeQ 会检查该账号的在线能力。'}
                </p>
              )}
              {onlineStep === 'entering' && <p role="status">正在启用 QQ 在线能力，请稍候。</p>}
              {reason && (
                <>
                  {reason.code === 'data-access' ? (
                    <QqDataAccessNotice showRetry={false} checked={dataRetried} />
                  ) : (
                    <div className="weq-restricted-reason">
                      <h4>{reason.title}</h4>
                      {!(showDebugCopy && (offline || sipLimited)) && <p>{reason.guidance}</p>}
                    </div>
                  )}
                  {proxyLogin && <p>{qqProxySetupGuide(proxyLogin.port)}</p>}
                  {error && <p role="alert">{error}</p>}
                  {actions}
                </>
              )}
              {authorizationRequest && (
                <AuthorizationForm
                  key={`${authorizationRequest.kind}:${authorizationRequest.token}`}
                  request={authorizationRequest}
                />
              )}
            </section>
          )}
          {showProxy && (
            <section aria-label="QQ 代理连接" className="weq-qq-status-section">
              <h3>
                <Network size={15} aria-hidden /> QQ 代理连接
              </h3>
              <p role="status">
                {proxyConnecting || proxyStatus.waiting ? (
                  <LoadingIndicator>{proxyLabel}</LoadingIndicator>
                ) : (
                  proxyLabel
                )}
              </p>
              {proxyAttention && proxyImpact && <p>暂时无法使用{proxyImpact}。</p>}
              {proxyStatus.isError ? (
                <p role="alert">暂时无法确认代理连接，稍后会自动再试。</p>
              ) : proxyAttention && proxy && !proxyConnecting ? (
                <>
                  {proxy.error && <p role="alert">{proxy.error}</p>}
                  {!proxy.running && !proxy.error && <p role="alert">本机代理尚未启动。</p>}
                  {canConfigureProxy && <p>{qqProxySetupGuide(proxy.port)}</p>}
                </>
              ) : null}
              {canConfigureProxy ? (
                <QqProxyRecovery
                  key={sourceKey}
                  onLaunch={refreshProxyAndOnline}
                  needsCurrentLogin={false}
                >
                  {proxySettings}
                </QqProxyRecovery>
              ) : (
                proxySettings && <div className="weq-restricted-actions">{proxySettings}</div>
              )}
            </section>
          )}
        </div>
      </section>
    )
  );
}
