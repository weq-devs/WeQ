import { useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { IS_MAC } from '../../lib/target';
import type { QqDataAccess } from '../../../../main/qq_data_access';
import '../../styles/qq-data-access.css';

export function QqDataAccessNotice({
  showRetry = true,
  checked = false,
}: {
  showRetry?: boolean;
  checked?: boolean;
}) {
  const access = trpc.bootstrap.qqDataAccess.useQuery(undefined, {
    enabled: IS_MAC,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retried, setRetried] = useState(false);
  if (
    !IS_MAC ||
    (!access.error && access.data?.status !== 'denied' && access.data?.status !== 'error')
  )
    return null;

  async function retry() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await access.refetch();
      if (result.error) throw result.error;
      setRetried(true);
      if (result.data?.status === 'readable' || result.data?.status === 'not-found') {
        await Promise.all([
          utils.bootstrap.listAccounts.invalidate(),
          utils.bootstrap.listAccountConfigs.invalidate(),
          utils.bootstrap.describeInstall.invalidate(),
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <QqDataAccessPrompt
      access={access.data}
      busy={busy || access.isFetching}
      retried={retried || checked}
      showRetry={showRetry}
      error={error || access.error?.message}
      onRetry={() => void retry()}
      onSettings={() => {
        setError('');
        void client.bootstrap.openQqDataAccessSettings
          .mutate()
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      }}
    />
  );
}

export function QqDataAccessPrompt({
  access,
  busy,
  retried,
  error,
  onRetry,
  onSettings,
  showRetry = true,
}: {
  access?: QqDataAccess;
  busy: boolean;
  retried: boolean;
  error?: string;
  onRetry: () => void;
  onSettings: () => void;
  showRetry?: boolean;
}) {
  const denied = access?.status === 'denied';
  return (
    <section className="weq-qq-data-access" aria-labelledby="qq-data-access-title" role="alert">
      <h3 id="qq-data-access-title">{denied ? 'QQ 数据读取受限' : 'QQ 数据读取检测失败'}</h3>
      {denied ? (
        <>
          <p>
            请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中添加并开启当前应用，再重新检测。
          </p>
          <p>如果此前已授权，更新后可能需要移除旧条目并重新添加当前应用。</p>
        </>
      ) : (
        <p>读取 QQ 数据时遇到其他错误，尚不能确认为授权问题。请检查数据目录或查看日志后重试。</p>
      )}
      {denied && access?.launchApplicationPath && (
        <p>
          当前应用由其他应用启动。命令行开发版可能继承启动来源的访问权限，仅授权 Electron
          可能不够；请同时检查下方启动来源的完全磁盘访问权限，并从该来源重新启动 WeQ。
        </p>
      )}
      <details>
        <summary>查看应用与读取路径</summary>
        {access?.applicationPath && (
          <p className="weq-qq-data-access-path">当前应用：{access.applicationPath}</p>
        )}
        {access?.launchApplicationPath && (
          <p className="weq-qq-data-access-path">启动来源：{access.launchApplicationPath}</p>
        )}
        {access?.issues[0] && (
          <p className="weq-qq-data-access-path">
            读取失败：{access.issues[0].path}（{access.issues[0].code}）
          </p>
        )}
      </details>
      {retried && denied && (
        <p>当前进程仍无法读取。若已完成授权，请彻底退出 WeQ 后重新启动，而不是仅关闭窗口。</p>
      )}
      {error && <p>{error}</p>}
      <div className="weq-restricted-actions">
        {denied && (
          <button type="button" className="weq-set-btn" disabled={busy} onClick={onSettings}>
            <FolderOpen size={15} aria-hidden />
            打开系统设置
          </button>
        )}
        {showRetry && (
          <button type="button" className="weq-set-btn" disabled={busy} onClick={onRetry}>
            <RefreshCw size={15} aria-hidden />
            {busy ? '正在检测' : '重新检测'}
          </button>
        )}
      </div>
    </section>
  );
}
