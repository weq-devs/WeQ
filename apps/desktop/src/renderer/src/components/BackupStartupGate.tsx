import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react';
import { client } from '../trpc/client';
import {
  restoreBackupClient,
  serializeBackupClient,
  type BackupStartupState,
} from '../lib/backupClientRestore';
import { useThemeStore } from '../state/theme';
import { usePrivacyStore } from '../state/privacy';
import { useToast } from './Toast';
import { startupDeadline } from '../lib/startupDeadline';
import { publishRemoteStartup } from '../lib/remoteStartup';
import '../styles/backup.css';
import { IS_WEB } from '../lib/target';
import { WebStartupCache, hydrateWebStartupCache } from '../lib/webStartupCache';
import { WarmupSplash } from './WarmupSplash';
import { advanceStartup } from '../state/startupProgress';

const RUNTIME_ERROR_KEY = 'weq.runtime-file-error';

/** 业务视图挂载前交接界面偏好；文件事务失败时不进入 Native／账号启动。 */
export function BackupStartupGate({ children }: { children: ReactNode }) {
  const queryCache = useContext(WebStartupCache);
  const [state, setState] = useState<BackupStartupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let revision: number | undefined;
    const subscription = client.bootstrap.onRuntimeFilesChanged.subscribe(undefined, {
      onData(state) {
        if (revision !== undefined && state.revision !== revision) {
          try {
            if (state.error) sessionStorage.setItem(RUNTIME_ERROR_KEY, state.error);
            else sessionStorage.removeItem(RUNTIME_ERROR_KEY);
          } catch {}
          window.location.reload();
        }
        revision = state.revision;
      },
    });
    return () => subscription.unsubscribe();
  }, []);
  const load = useCallback(
    async (recover = false) => {
      const seq = ++generation.current;
      setBusy(true);
      setError(null);
      advanceStartup('restore');
      publishRemoteStartup({ state: 'loading', message: '正在检查恢复状态' });
      try {
        if (recover) await client.bootstrap.backupRetryRecovery.mutate();
        const result = await startupDeadline((signal) =>
          serializeBackupClient(
            () =>
              restoreBackupClient(
                {
                  read: async (clientId) => {
                    const input = clientId ? { clientId } : undefined;
                    if (!IS_WEB) return client.bootstrap.backupStartup.query(input, { signal });
                    const response = await client.startup.snapshot.query(input, { signal });
                    if (response.snapshot && queryCache)
                      hydrateWebStartupCache(queryCache, response.snapshot);
                    return response.backup;
                  },
                  applyShared: async (receiptId, values) => {
                    const snapshot = await client.clientState.restoreLegacyPreferences.mutate(
                      { receiptId, values },
                      { signal },
                    );
                    const { acceptPreferences } = await import('../lib/clientPreferences');
                    acceptPreferences(snapshot);
                  },
                  acknowledge: (id, clientId) =>
                    client.bootstrap.backupAcknowledgeClient.mutate({ id, clientId }, { signal }),
                },
                () => window.localStorage,
              ),
            signal,
          ),
        );
        if (seq !== generation.current) return;
        setState(result);
        if (result.toastDurations) useToast.getState().setDurations(result.toastDurations);
        if (result.ok) {
          useThemeStore.getState().hydrate();
          usePrivacyStore.getState().hydrate();
          try {
            const failure = sessionStorage.getItem(RUNTIME_ERROR_KEY);
            sessionStorage.removeItem(RUNTIME_ERROR_KEY);
            if (failure) setError(failure);
          } catch {}
        } else setError(result.error || '文件恢复尚未完成');
      } catch (e) {
        if (seq !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
        // 界面交接文件损坏时仍可显示已提交的数据回执，供用户明确放弃界面部分。
        try {
          const status = await startupDeadline(
            (signal) => client.bootstrap.backupStatus.query(undefined, { signal }),
            3_000,
          );
          if (seq !== generation.current) return;
          setState((previous) =>
            previous
              ? { ...previous, result: status.result }
              : {
                  ok: false,
                  error: null,
                  result: status.result,
                  appliedThisStartup: false,
                  client: null,
                  canReveal: false,
                  canRestart: false,
                },
          );
        } catch {}
      } finally {
        if (seq === generation.current) setBusy(false);
      }
    },
    [queryCache],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (busy) return;
    if (state?.ok && !error) return;
    if ((state?.ok === false && state.error) || state?.result?.clientPending)
      publishRemoteStartup({ state: 'action-required' });
    else if (error) publishRemoteStartup({ state: 'error', message: error });
  }, [busy, error, state]);
  if (!busy && state?.ok && !error) return children;
  if (busy)
    return (
      <main className="weq-home-shell weq-initial-startup" data-weq-startup-pending>
        <WarmupSplash hint="正在检查恢复状态" />
      </main>
    );
  const canSkip = state?.result?.status === 'applied' && state.result.clientPending;
  return (
    <main className="weq-backup-gate">
      <section className="weq-backup-gate-content" aria-busy={busy}>
        <ShieldAlert size={28} aria-hidden />
        <h1>{busy ? '正在检查恢复状态' : '恢复需要处理'}</h1>
        {error ? <p role="alert">{error}</p> : null}
        {!busy ? (
          <>
            <p>
              {canSkip
                ? 'WeQ 数据已提交，界面偏好尚未完成。'
                : '业务服务尚未启动，恢复现场已保留。'}
            </p>
            <div className="weq-backup-actions">
              <button
                className="weq-set-btn"
                type="button"
                onClick={() => void load(state?.ok === false && Boolean(state.error))}
              >
                <RefreshCw size={14} />
                重试恢复
              </button>
              {state?.canReveal ? (
                <button
                  className="weq-set-btn"
                  type="button"
                  onClick={() =>
                    void client.bootstrap.backupOpenDirectory
                      .mutate()
                      .catch((e: unknown) => setError(String(e)))
                  }
                >
                  <FolderOpen size={14} />
                  打开数据目录
                </button>
              ) : null}
              {canSkip ? (
                <button className="weq-set-btn" type="button" onClick={() => setConfirmSkip(true)}>
                  保留本机界面偏好
                </button>
              ) : null}
            </div>
            {confirmSkip ? (
              <div className="weq-backup-review">
                <p>
                  放弃本次备份的界面偏好恢复？已恢复的 WeQ
                  数据不会撤销，其他设备也不会再应用这份界面偏好。
                </p>
                <div className="weq-backup-actions">
                  <button
                    className="weq-set-btn"
                    type="button"
                    onClick={() => setConfirmSkip(false)}
                  >
                    返回
                  </button>
                  <button
                    className="weq-set-btn"
                    type="button"
                    onClick={() => {
                      const id = state?.result?.id;
                      if (!id) return;
                      setBusy(true);
                      void client.bootstrap.backupSkipClient
                        .mutate({ id })
                        .then((ok) => {
                          if (!ok) throw new Error('恢复回执已变化，请重试读取');
                          setConfirmSkip(false);
                          return load();
                        })
                        .catch((e: unknown) => {
                          setError(String(e));
                          setBusy(false);
                        });
                    }}
                  >
                    确认保留本机偏好
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
