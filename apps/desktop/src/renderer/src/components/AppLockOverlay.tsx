import { useEffect, useState, type ReactElement } from 'react';
import { KeyRound, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog, Modal } from './Dialog';
import { useViewState } from '../state/view';
import { useAppLock } from '../state/lock';

type SystemAuthStatus = Awaited<ReturnType<typeof window.weq.systemAuth.getStatus>>;

/** Reset the idle timer on any of these. */
const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

export function AppLockOverlay(): ReactElement | null {
  const view = useViewState((s) => s.view);
  const showError = useDialog((s) => s.showError);
  const locked = useAppLock((s) => s.locked);
  const lock = useAppLock((s) => s.lock);
  const unlock = useAppLock((s) => s.unlock);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [status, setStatus] = useState<SystemAuthStatus | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const autoLockMinutes = settings.data?.autoLockMinutes ?? 0;
  const inMain = view === 'main';

  useEffect(() => {
    void window.weq.systemAuth
      .getStatus()
      .then(setStatus)
      .catch((error) => {
        setStatus(null);
        showError('读取系统认证状态失败', error instanceof Error ? error.message : String(error));
      });
  }, [showError]);

  // Leaving the main view (switch account / sign out) clears the lock — the
  // bootstrap home is its own gate and a stale lock there would trap the user.
  useEffect(() => {
    if (!inMain && locked) unlock();
  }, [inMain, locked, unlock]);

  // Idle auto-lock. Only armed in the main view, when a positive threshold is
  // set, the platform can actually verify, and we're not already locked.
  const idleArmed =
    inMain && !locked && autoLockMinutes > 0 && status?.available === true;

  useEffect(() => {
    if (!idleArmed) return undefined;

    let timer = window.setTimeout(lock, autoLockMinutes * 60_000);
    const reset = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, autoLockMinutes * 60_000);
    };

    for (const evt of IDLE_EVENTS) window.addEventListener(evt, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const evt of IDLE_EVENTS) window.removeEventListener(evt, reset);
    };
  }, [idleArmed, autoLockMinutes, lock]);

  const unlockable = status?.available === true;

  async function doUnlock(): Promise<void> {
    setUnlocking(true);
    try {
      const result = await window.weq.systemAuth.verify('解锁 WeQ');
      if (result.success) {
        unlock();
        return;
      }
      showError('解锁失败', result.error ?? '系统认证未通过。');
    } catch (error) {
      showError('解锁失败', error instanceof Error ? error.message : String(error));
    } finally {
      setUnlocking(false);
    }
  }

  if (!inMain || !locked) return null;

  return (
    <Modal labelledBy="weq-lock-title" width={380}>
      <div className="weq-lock">
        <div className="weq-lock-head">
          <span className="weq-lock-icon">
            <LockKeyhole size={18} strokeWidth={1.9} aria-hidden />
          </span>
          <div className="weq-lock-heading">
            <h3 id="weq-lock-title" className="weq-lock-title">
              WeQ 已锁定
            </h3>
            <span className="weq-lock-badge">
              <ShieldCheck size={12} strokeWidth={2} aria-hidden />
              隐私保护已开启
            </span>
          </div>
        </div>

        <p className="weq-lock-desc">
          {unlockable
            ? `请使用 ${status?.displayName ?? '系统认证'} 验证身份后继续访问当前账号数据。`
            : status?.error ?? '系统认证当前不可用，请在系统中重新启用后再试。'}
        </p>
        <p className="weq-lock-tip">解锁需要通过系统认证，没有跳过入口。</p>

        <div className="weq-lock-foot">
          <button
            type="button"
            className="weq-action-primary"
            onClick={() => void doUnlock()}
            disabled={unlocking || !unlockable}
          >
            {unlocking ? (
              <Loader2 size={14} className="weq-spin" aria-hidden />
            ) : (
              <KeyRound size={14} aria-hidden />
            )}
            立即解锁
          </button>
        </div>
      </div>
    </Modal>
  );
}
