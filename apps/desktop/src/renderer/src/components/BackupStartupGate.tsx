import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react';
import { client } from '../trpc/client';
import {
  restoreBackupClient,
  serializeBackupClient,
  type BackupStartupState,
} from '../lib/backupClientRestore';
import { useThemeStore } from '../state/theme';
import { usePrivacyStore } from '../state/privacy';
import { useGroupBadgeDisplay } from '../state/groupBadge';
import { useToast } from './Toast';
import '../styles/backup.css';

/** 业务视图挂载前交接界面偏好；文件事务失败时不进入 Native／账号启动。 */
export function BackupStartupGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BackupStartupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (recover = false) => {
    const seq = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      if (recover) await client.bootstrap.backupRetryRecovery.mutate();
      const result = await serializeBackupClient(() =>
        restoreBackupClient(
          {
            read: (clientId) =>
              client.bootstrap.backupStartup.query(clientId ? { clientId } : undefined),
            acknowledge: (id, clientId) =>
              client.bootstrap.backupAcknowledgeClient.mutate({ id, clientId }),
          },
          () => window.localStorage,
        ),
      );
      if (seq !== generation.current) return;
      setState(result);
      if (result.appliedThisStartup && result.result) {
        try {
          setNoticeDismissed(localStorage.getItem('weq.backup-result-seen') === result.result.id);
        } catch {}
      }
      if (result.toastDurations) useToast.getState().setDurations(result.toastDurations);
      if (result.ok) {
        useThemeStore.getState().hydrate();
        usePrivacyStore.getState().hydrate();
        useGroupBadgeDisplay.getState().reload();
      } else setError(result.error || '文件恢复尚未完成');
    } catch (e) {
      if (seq !== generation.current) return;
      setError(e instanceof Error ? e.message : String(e));
      // 界面交接文件损坏时仍可显示已提交的数据回执，供用户明确放弃界面部分。
      try {
        const status = await client.bootstrap.backupStatus.query();
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
  }, []);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const notice = state?.appliedThisStartup && !noticeDismissed ? state.result : null;
  if (!busy && state?.ok && !error && !notice) return children;
  if (!busy && state?.ok && !error && notice)
    return (
      <main className="weq-backup-gate">
        <section className="weq-backup-gate-content">
          <h1>{notice.status === 'applied' ? '备份恢复已应用' : '备份恢复未应用'}</h1>
          <p>
            {notice.error ||
              `已应用 ${notice.applied.length} 项，跳过 ${notice.skipped.length} 项。`}
          </p>
          {notice.clientPending ? (
            <p>界面偏好等待发起恢复的设备确认，可在设置中改到当前设备恢复。</p>
          ) : null}
          {notice.warnings.length ? (
            <ul className="weq-backup-list">
              {notice.warnings.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => {
              try {
                localStorage.setItem('weq.backup-result-seen', notice.id);
              } catch {}
              setNoticeDismissed(true);
            }}
          >
            继续
          </button>
        </section>
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
