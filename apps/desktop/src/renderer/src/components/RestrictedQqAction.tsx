import { useEffect, useId, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, Play, RefreshCw, Settings, X } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { QqDebugCopy } from './QqDebugCopy';
import '../styles/qq-debug-copy.css';

/** 受限详情只呈现下一步；副本管理复用设置中的完整面板。 */
export function RestrictedQqAction({
  needsQq,
  busy,
  onOpened,
  onEnable,
  onRetry,
}: {
  needsQq: boolean;
  busy: boolean;
  onOpened: () => Promise<void>;
  onEnable: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const status = trpc.bootstrap.qqDebugCopyStatus.useQuery(undefined, {
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mounted = useRef(true);
  const locked = useRef(false);
  const titleId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const data = status.data;
  const running = Boolean(data?.runningPids.length);
  const canSwitch = Boolean(data?.sourceRunningPids?.length);
  const copyWorking = pending || Boolean(data && data.phase !== 'idle');
  const working = copyWorking || (!needsQq && busy);
  const prepare = data?.state === 'missing' || data?.state === 'invalid';
  const blocked =
    needsQq &&
    (!data || data.state === 'unmanaged' || (prepare && (!data.sourceVersion || running)));
  const label = working
    ? needsQq
      ? '正在打开 QQ'
      : '正在启用完整功能'
    : !needsQq
      ? '启用完整功能'
      : data?.state === 'missing'
        ? '准备并打开 QQ'
        : data?.state === 'invalid'
          ? '修复并打开 QQ'
          : running
            ? '登录其他账号'
            : '打开 QQ';
  async function run(action: 'open' | 'activate' | 'switch' = 'open') {
    if (locked.current || copyWorking || (action === 'open' && working)) return;
    locked.current = true;
    setPending(true);
    setError('');
    try {
      if (!needsQq && action === 'open') await onEnable();
      else {
        await client.bootstrap.qqDebugCopyAction.mutate({ action });
        if (!mounted.current) return;
        if (action !== 'activate') {
          setWaiting(true);
          await onOpened();
        }
        await status.refetch();
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="weq-restricted-qq">
      {waiting && needsQq && <p role="status">请在 QQ 中完成登录，登录后会自动继续。</p>}
      {needsQq && data?.state === 'unmanaged' && (
        <p role="alert">副本位置已被其他应用占用，请在副本设置中查看。</p>
      )}
      {needsQq && prepare && running && (
        <p role="alert">请先从副本菜单退出 QQ，再修复并打开；其他 QQ 不受影响。</p>
      )}
      {needsQq && prepare && !data.sourceVersion && (
        <p role="alert">未检测到 QQ 安装，请安装 QQ 后重新检查。</p>
      )}
      {needsQq && data && !data.readerReady && (
        <p role="alert">当前 WeQ 构建缺少调试权限，请使用带调试权限的桌面构建。</p>
      )}
      {(error || status.error) && <p role="alert">{error || status.error?.message}</p>}
      <div className="weq-restricted-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={working || blocked}
          aria-busy={working}
          onClick={() => void run()}
        >
          {working ? (
            <LoaderCircle size={14} className="weq-restricted-progress-icon" />
          ) : needsQq ? (
            <Play size={14} />
          ) : (
            <KeyRound size={14} />
          )}
          {label}
        </button>
        {canSwitch && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={
              copyWorking ||
              data?.state === 'unmanaged' ||
              (prepare && (!data?.sourceVersion || running))
            }
            onClick={() => void run('switch')}
          >
            <RefreshCw size={14} />
            退出普通 QQ 并打开副本
          </button>
        )}
        <details className="weq-restricted-more">
          <summary>更多</summary>
          <div className="weq-restricted-actions">
            {running && (
              <button
                type="button"
                className="weq-set-btn"
                disabled={copyWorking || data?.state === 'invalid'}
                onClick={() => void run('activate')}
              >
                <Play size={14} />
                打开已有 QQ 窗口
              </button>
            )}
            <button type="button" className="weq-set-btn" onClick={() => setSettingsOpen(true)}>
              <Settings size={14} />
              副本设置
            </button>
            <button
              type="button"
              className="weq-set-btn"
              disabled={working}
              onClick={() => void onRetry()}
            >
              <RefreshCw size={14} />
              重新检查
            </button>
          </div>
        </details>
      </div>
      {settingsOpen && (
        <Modal
          open
          centered
          labelledBy={titleId}
          className="weq-qq-debug-modal"
          onClose={() => setSettingsOpen(false)}
          width={520}
        >
          <div className="weq-dialog-head">
            <h3 id={titleId} className="weq-dialog-title">
              QQ 调试副本
            </h3>
            <button
              type="button"
              className="weq-dialog-x"
              title="关闭"
              aria-label="关闭副本设置"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="weq-dialog-body">
            <QqDebugCopy />
          </div>
        </Modal>
      )}
    </div>
  );
}
