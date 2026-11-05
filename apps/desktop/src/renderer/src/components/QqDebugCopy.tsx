import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Play, RefreshCw, Trash2 } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { useTabActive } from './RetainedTabs';
import type { QqDebugCopyAction, QqDebugCopyPhase } from '../../../shared/qq_debug_copy';
import '../styles/qq-debug-copy.css';

const PHASE_LABELS: Record<QqDebugCopyPhase, string> = {
  idle: '',
  checking: '正在检查环境',
  copying: '正在创建副本',
  signing: '正在配置调试签名',
  verifying: '正在校验副本',
  launching: '正在启动副本',
  removing: '正在移除副本',
};

export function QqDebugCopy({
  onCheck,
  showRetry = true,
}: {
  onCheck?: () => Promise<void>;
  showRetry?: boolean;
}) {
  const active = useTabActive();
  const status = trpc.bootstrap.qqDebugCopyStatus.useQuery(undefined, {
    enabled: active,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [pending, setPending] = useState<QqDebugCopyAction | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const mounted = useRef(true);
  const confirm = useDialog((s) => s.confirm);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const data = status.data;
  const busy = Boolean(pending || (data && data.phase !== 'idle'));
  const managed = data && data.state !== 'missing' && data.state !== 'unmanaged';
  const ready = data?.state === 'ready' || data?.state === 'outdated';
  const running = Boolean(data?.runningPids.length);
  async function run(action: QqDebugCopyAction) {
    if (locked.current || busy) return;
    locked.current = true;
    setPending(action);
    setError('');
    setNotice('');
    try {
      if (
        action === 'remove' &&
        !(await confirm(
          '移除 QQ 调试副本',
          '只移除 WeQ 创建的 QQ 副本，保留原 QQ、账号登录态和聊天数据。',
          { okLabel: '移除副本' },
        ))
      )
        return;
      if (!mounted.current) return;
      await client.bootstrap.qqDebugCopyAction.mutate({ action });
      await status.refetch();
      if (!mounted.current) return;
      if (action === 'verify' && onCheck) await onCheck();
      if (mounted.current)
        setNotice(
          action === 'launch'
            ? '已请求打开副本，请在副本中登录目标账号，再检查在线凭据。'
            : action === 'prepare'
              ? '副本已准备好，请启动并登录目标账号。'
              : action === 'remove'
                ? '副本已移除，原 QQ 与聊天数据已保留。'
                : '副本校验通过。',
        );
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      await status.refetch().catch(() => undefined);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  }
  return (
    <div className="weq-qq-debug">
      <p className="weq-qq-debug-intro">
        保留 SIP 开启，使用可调试的 QQ 副本。副本与原 QQ 共用账号和聊天数据，不替换原安装。
      </p>
      <ol className="weq-qq-debug-checks" aria-label="调试副本状态">
        <li data-ready={data?.readerReady === true}>
          {data?.readerReady ? <Check size={15} /> : <span className="weq-qq-debug-marker" />}
          <span>WeQ 读取端</span>
          <strong>
            {!data ? '待检测' : data.readerReady ? '调试权限已就绪' : '当前构建缺少调试权限'}
          </strong>
        </li>
        <li data-ready={Boolean(ready)}>
          {ready ? <Check size={15} /> : <span className="weq-qq-debug-marker" />}
          <span>QQ 副本</span>
          <strong>
            {!data
              ? '待检测'
              : (
                  {
                    missing: '未创建',
                    ready: '已就绪',
                    outdated: '可更新',
                    invalid: '需要修复',
                    unmanaged: '位置已占用',
                  } as const
                )[data.state]}
          </strong>
        </li>
        <li data-ready={running}>
          {running ? <Check size={15} /> : <span className="weq-qq-debug-marker" />}
          <span>副本进程</span>
          <strong>{running ? '正在运行，登录状态待检查' : '未启动'}</strong>
        </li>
      </ol>
      {data && (
        <dl className="weq-qq-debug-details">
          <div>
            <dt>原安装</dt>
            <dd>{data.sourceVersion ?? '未检测到'}</dd>
          </div>
          <div>
            <dt>副本位置</dt>
            <dd>{data.path}</dd>
          </div>
        </dl>
      )}
      {data && <p className="weq-qq-debug-message">{data.message}</p>}
      {data && !data.readerReady && (
        <p className="weq-qq-debug-message">
          请使用带调试权限的 WeQ 桌面构建；仅创建 QQ 副本不能补齐读取端权限。
        </p>
      )}
      <p className="weq-qq-debug-message">
        副本允许本机具备调试权限的程序读取其内存。仅在本机使用，不要分发副本。
      </p>
      {running && (
        <p className="weq-qq-debug-message">
          更新或移除前，请从副本菜单退出 QQ；WeQ 不会自动退出其他 QQ。
        </p>
      )}
      {busy && (
        <p className="weq-qq-debug-progress" role="status">
          <LoaderCircle size={14} />
          {data?.phase && data.phase !== 'idle' ? PHASE_LABELS[data.phase] : '正在处理，请稍候'}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {(error || status.error) && <p role="alert">{error || status.error?.message}</p>}
      <div className="weq-qq-debug-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || !data?.sourceVersion || data.state === 'unmanaged' || running}
          onClick={() => void run('prepare')}
        >
          <Copy size={14} />
          {managed ? (data?.state === 'invalid' ? '重新准备副本' : '更新副本') : '创建副本'}
        </button>
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy || !ready || running}
          onClick={() => void run('launch')}
        >
          <Play size={14} />
          启动副本
        </button>
        {showRetry && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() => (ready ? void run('verify') : void status.refetch())}
          >
            <RefreshCw size={14} />
            {onCheck && ready ? '检查在线凭据' : '重新检查'}
          </button>
        )}
        {managed && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy || running}
            onClick={() => void run('remove')}
          >
            <Trash2 size={14} />
            移除副本
          </button>
        )}
      </div>
    </div>
  );
}
