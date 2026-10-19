import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, Play, Power, RefreshCw } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import type { QQRuntimePhase } from '@weq/service';
import { useToast } from '../../components/Toast';
import '../../styles/managed-qq.css';

const labels: Record<QQRuntimePhase, string> = {
  stopped: '未启动',
  starting: '正在启动 QQ',
  connecting: '正在连接',
  'awaiting-login': '等待登录',
  scanned: '已扫码，请在手机上确认',
  'initializing-session': '正在准备账号与数据库',
  online: '已就绪',
  recovering: '正在恢复连接',
  failed: '连接失败',
  stopping: '正在停止',
};

export function ManagedQQPanel({
  expectedUin,
  expectedConfigId,
  autoStart = false,
  onAutoStartConsumed,
  defaultAutoEnter = false,
  onEntered,
}: {
  expectedUin?: string;
  expectedConfigId?: string;
  autoStart?: boolean;
  onAutoStartConsumed?(): void;
  defaultAutoEnter?: boolean;
  onEntered(uin: string): void;
}) {
  const status = trpc.qqRuntime.status.useQuery(undefined, {
    refetchInterval: 1000,
    refetchOnWindowFocus: false,
  });
  const start = trpc.qqRuntime.start.useMutation(),
    stop = trpc.qqRuntime.stop.useMutation();
  const refresh = trpc.qqRuntime.refreshQr.useMutation(),
    official = trpc.qqRuntime.openOfficial.useMutation();
  const enable = trpc.bootstrap.setAutoAttachQq.useMutation();
  const preference = trpc.qqRuntime.setAutoEnter.useMutation();
  const closeBehavior = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const utils = trpc.useUtils();
  const [autoEnter, setAutoEnter] = useState(defaultAutoEnter);
  const preferenceDirty = useRef(false),
    entering = useRef(false),
    autoAttempted = useRef(false);
  const [error, setError] = useState('');
  const qrRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true),
    entered = useRef(false),
    ownedInstance = useRef<string | null>(null);
  const state = status.data?.state;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (state?.qr?.pngBase64) qrRef.current?.scrollIntoView({ block: 'nearest' });
  }, [state?.qr?.pngBase64]);
  const statusRef = useRef(status.data);
  statusRef.current = status.data;
  useEffect(() => {
    if (!preferenceDirty.current) setAutoEnter(defaultAutoEnter);
  }, [defaultAutoEnter]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const instanceId = ownedInstance.current;
      if (!entered.current && instanceId)
        void client.qqRuntime.stop
          .mutate({ expectedInstanceId: instanceId, closeAccount: true })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (
      entered.current ||
      entering.current ||
      state?.mode !== 'managed' ||
      !state.owned ||
      !state.instanceId ||
      !state?.capabilities.database ||
      state.phase !== 'online' ||
      !state.account ||
      status.data?.openedInstanceId !== state.instanceId ||
      status.data.openedUin !== state.account.uin
    )
      return;
    if (expectedUin && state.account.uin !== expectedUin) return;
    if (expectedConfigId && status.data.openedConfigId !== expectedConfigId) return;
    const uin = state.account.uin,
      instanceId = state.instanceId;
    const enter = () => {
      const latest = statusRef.current;
      if (
        !mounted.current ||
        latest?.state.instanceId !== instanceId ||
        latest.state.phase !== 'online' ||
        latest.state.mode !== 'managed' ||
        !latest.state.owned ||
        !latest.state.capabilities.database ||
        latest.openedInstanceId !== instanceId ||
        latest.openedUin !== uin ||
        (expectedConfigId && latest.openedConfigId !== expectedConfigId)
      )
        return;
      entered.current = true;
      onEntered(uin);
    };
    if (!preferenceDirty.current) {
      enter();
      return;
    }
    entering.current = true;
    void preference
      .mutateAsync({ expectedInstanceId: instanceId, enabled: autoEnter })
      .then(() => utils.bootstrap.getAutoEnter.invalidate())
      .catch(() => {
        if (mounted.current)
          useToast.getState().push({ tone: 'error', title: '自动进入设置未保存' });
      })
      .finally(() => {
        entering.current = false;
        enter();
      });
  }, [
    state,
    status.data,
    expectedUin,
    expectedConfigId,
    onEntered,
    autoEnter,
    preference.mutateAsync,
    utils,
  ]);

  const startMutation = start.mutateAsync,
    refreshStatus = status.refetch;
  const begin = useCallback(async () => {
    setError('');
    try {
      const result = await startMutation({
        expectedInstanceId: stateRef.current?.instanceId ?? null,
        ...(expectedUin ? { uin: expectedUin } : {}),
        ...(expectedConfigId ? { expectedAccountConfigId: expectedConfigId } : {}),
      });
      ownedInstance.current = result.instanceId;
      if (!mounted.current && result.instanceId) {
        await client.qqRuntime.stop.mutate({
          expectedInstanceId: result.instanceId,
          closeAccount: true,
        });
        return;
      }
      await refreshStatus();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [startMutation, refreshStatus, expectedUin, expectedConfigId]);
  useEffect(() => {
    if (!autoStart || autoAttempted.current || !status.data) return;
    autoAttempted.current = true;
    onAutoStartConsumed?.();
    if (
      !status.data.enabled ||
      !status.data.supported ||
      !['stopped', 'failed'].includes(status.data.state.phase)
    )
      return;
    void begin();
  }, [autoStart, status.data, onAutoStartConsumed, begin]);
  async function act(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      if (mounted.current) await status.refetch();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function settingsAction(action: () => Promise<unknown>) {
    await act(async () => {
      await action();
      await utils.bootstrap.getSettings.invalidate();
    });
  }
  const busy =
    start.isLoading ||
    stop.isLoading ||
    refresh.isLoading ||
    enable.isLoading ||
    preference.isLoading ||
    closeBehavior.isLoading ||
    state?.phase === 'starting' ||
    state?.phase === 'stopping';
  const running = state?.mode === 'managed' && state.phase !== 'stopped';
  const binding = { expectedInstanceId: state?.instanceId ?? null };
  return (
    <section className="weq-managed-qq" aria-label="托管 QQ">
      <label className="weq-managed-qq-online">
        <input
          type="checkbox"
          checked={status.data?.enabled === true}
          disabled={busy || !status.data}
          onChange={(event) =>
            void settingsAction(() => enable.mutateAsync({ enabled: event.target.checked }))
          }
        />
        <span>完整在线功能</span>
      </label>
      <label className="weq-managed-qq-online">
        <input
          type="checkbox"
          checked={autoEnter}
          disabled={busy}
          onChange={(event) => {
            preferenceDirty.current = true;
            setAutoEnter(event.target.checked);
          }}
        />
        <span>下次打开自动进入该账号</span>
      </label>
      {status.data?.supported && (
        <label className="weq-managed-qq-policy">
          <span>关闭窗口时</span>
          <select
            aria-label="关闭窗口时"
            value={status.data.closeBehavior ?? 'ask'}
            disabled={busy}
            onChange={(event) => {
              const behavior = event.target.value;
              if (behavior === 'ask' || behavior === 'tray' || behavior === 'quit')
                void settingsAction(() => closeBehavior.mutateAsync({ behavior }));
            }}
          >
            <option value="ask">询问</option>
            <option value="tray">托盘运行</option>
            <option value="quit">完全退出</option>
          </select>
        </label>
      )}
      <div className="weq-managed-qq-status" role="status">
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
        <span>
          {status.data?.supported === false
            ? '当前环境不支持托管 QQ'
            : status.data?.enabled === false
              ? '完全离线模式已开启'
              : state
                ? labels[state.phase]
                : '正在读取运行状态'}
        </span>
        {state?.account && <span className="weq-managed-qq-uin">{state.account.uin}</span>}
      </div>
      {state?.qr && (
        <div className="weq-managed-qq-code" ref={qrRef}>
          <img
            src={`data:image/png;base64,${state.qr.pngBase64}`}
            alt="QQ 登录二维码"
            width={240}
            height={240}
          />
        </div>
      )}
      <div className="weq-managed-qq-actions">
        <button
          type="button"
          className="weq-action-primary"
          disabled={
            busy ||
            !status.data?.supported ||
            !status.data.enabled ||
            Boolean(running && state.phase !== 'failed')
          }
          onClick={() => void begin()}
        >
          <Play size={15} aria-hidden />
          {running ? '重新连接' : '启动并登录'}
        </button>
        {running && (
          <>
            <button
              type="button"
              className="weq-managed-qq-tool"
              title="刷新二维码"
              aria-label="刷新二维码"
              disabled={busy || !state.capabilities.login}
              onClick={() => void act(() => refresh.mutateAsync(binding))}
            >
              <RefreshCw size={17} aria-hidden />
            </button>
            <button
              type="button"
              className="weq-managed-qq-tool"
              title="停止托管 QQ"
              aria-label="停止托管 QQ"
              disabled={stop.isLoading}
              onClick={() => void act(() => stop.mutateAsync({ ...binding, closeAccount: true }))}
            >
              <Power size={17} aria-hidden />
            </button>
            <button
              type="button"
              className="weq-managed-qq-tool"
              title="打开官方 QQ"
              aria-label="打开官方 QQ"
              disabled={official.isLoading}
              onClick={() => void act(() => official.mutateAsync(binding))}
            >
              <ExternalLink size={17} aria-hidden />
            </button>
          </>
        )}
      </div>
      {(error || state?.error || status.error) && (
        <div role="alert" className="weq-managed-qq-error">
          {error || state?.error || status.error?.message}
        </div>
      )}
    </section>
  );
}
