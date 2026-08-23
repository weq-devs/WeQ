/**
 * 应用锁遮罩。解锁方式由设置（appLock.method）决定：
 *   - 'totp'   WeQ 验证器 —— 大号 6 位动态验证码输入框，错误抖动、成功展开
 *   - 'system' 系统认证（Windows Hello / Touch ID）
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Check, KeyRound, Loader2, LockKeyhole, ShieldCheck, Smartphone } from 'lucide-react';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { useViewState } from '../state/view';
import { useAppLock } from '../state/lock';
import { shellBridge } from '../lib/target';
import { TotpDigits } from './TotpDigits';

type SystemAuthStatus = Awaited<ReturnType<typeof window.weq.systemAuth.getStatus>>;
type TotpStatus = Awaited<ReturnType<typeof window.weq.totp.getStatus>>;

/** Reset the idle timer on any of these. */
const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
const TOTP_STEP_SECONDS = 30;

export function AppLockOverlay(): ReactElement | null {
  const view = useViewState((s) => s.view);
  const locked = useAppLock((s) => s.locked);
  const lock = useAppLock((s) => s.lock);
  const unlock = useAppLock((s) => s.unlock);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [status, setStatus] = useState<SystemAuthStatus | null>(null);
  const [totpStatus, setTotpStatus] = useState<TotpStatus | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const autoLockMinutes = settings.data?.autoLockMinutes ?? 0;
  const appLock = settings.data?.appLock;
  const inMain = view === 'main';
  const method = appLock?.method ?? 'totp';
  const lockEnabled = appLock?.enabled ?? true;

  useEffect(() => {
    const bridge = shellBridge();
    if (!bridge) return;
    let alive = true;
    void bridge.systemAuth
      .getStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    void bridge.totp
      .getStatus()
      .then((s) => {
        if (alive) setTotpStatus(s);
      })
      .catch(() => {
        if (alive) setTotpStatus(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Leaving the main view (switch account / sign out) clears the lock — the
  // bootstrap home is its own gate and a stale lock there would trap the user.
  useEffect(() => {
    if (!inMain && locked) unlock();
  }, [inMain, locked, unlock]);

  // Idle auto-lock. Only armed in the main view, when the lock is enabled, a
  // positive threshold is set, and the chosen method can actually unlock.
  const systemUnlockable = status?.available === true;
  const totpUnlockable = totpStatus?.configured === true;
  const unlockable = method === 'system' ? systemUnlockable : totpUnlockable;
  const idleArmed = inMain && !locked && lockEnabled && autoLockMinutes > 0 && unlockable;

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

  // ---- system auth (Windows Hello / Touch ID) ----
  const [systemError, setSystemError] = useState<string | null>(null);

  async function doSystemUnlock(): Promise<void> {
    setUnlocking(true);
    setSystemError(null);
    try {
      const result = await window.weq.systemAuth.verify('解锁 WeQ');
      if (result.success) {
        unlock();
        return;
      }
      setSystemError(result.error ?? '系统认证未通过。');
    } catch (error) {
      setSystemError(error instanceof Error ? error.message : String(error));
    } finally {
      setUnlocking(false);
    }
  }

  // ---- WeQ 验证器（TOTP）----
  const [totpError, setTotpError] = useState<string | null>(null);
  const [shakeSignal, setShakeSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [totpSuccess, setTotpSuccess] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(TOTP_STEP_SECONDS);

  useEffect(() => {
    const tick = (): void => {
      setSecondsLeft(TOTP_STEP_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_STEP_SECONDS));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  async function doTotpUnlock(code: string): Promise<void> {
    if (unlocking || totpSuccess) return;
    setUnlocking(true);
    setTotpError(null);
    try {
      const result = await window.weq.totp.verify(code);
      if (result.ok) {
        // 成功：先播放解锁动画，再真正放行。
        setTotpSuccess(true);
        window.setTimeout(() => unlock(), 750);
      } else {
        setTotpError(result.error ?? '验证码错误，请重试。');
        setShakeSignal((s) => s + 1);
        setResetSignal((s) => s + 1);
      }
    } catch (error) {
      setTotpError(error instanceof Error ? error.message : String(error));
      setShakeSignal((s) => s + 1);
      setResetSignal((s) => s + 1);
    } finally {
      setUnlocking(false);
    }
  }

  if (!inMain || !locked) return null;

  if (method === 'system') {
    return (
      <Modal
        labelledBy="weq-lock-title"
        width={380}
        className="weq-lock-modal"
        layerClassName="weq-lock-layer"
      >
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
            请使用 {status?.displayName ?? '系统认证'} 验证身份后继续访问当前账号数据。
          </p>
          {systemError ? (
            <p className="weq-totp-error is-show">{systemError}</p>
          ) : (
            <p className="weq-lock-tip">解锁需要通过系统认证。</p>
          )}

          <div className="weq-lock-foot">
            <button
              type="button"
              className="weq-action-primary"
              onClick={() => void doSystemUnlock()}
              disabled={unlocking || !systemUnlockable}
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

  return (
    <Modal
      labelledBy="weq-lock-title"
      width={460}
      className="weq-lock-modal"
      layerClassName="weq-lock-layer"
    >
      <div className={`weq-lock weq-lock-totp${totpSuccess ? ' is-unlocked' : ''}`}>
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

        {totpSuccess ? (
          <div className="weq-totp-success">
            <span className="weq-totp-success-ring">
              <Check size={30} strokeWidth={2.4} aria-hidden />
            </span>
            <strong>解锁成功</strong>
            <small>欢迎回来</small>
          </div>
        ) : (
          <div className="weq-totp-panel">
            <div className="weq-totp-panel-icon">
              <Smartphone size={18} strokeWidth={1.8} aria-hidden />
            </div>
            <p className="weq-lock-desc">请输入验证器 App 中的 6 位动态验证码</p>

            <TotpDigits
              size="lg"
              autoFocus
              disabled={unlocking}
              resetSignal={resetSignal}
              shakeSignal={shakeSignal}
              onComplete={(code) => void doTotpUnlock(code)}
            />

            <div className="weq-totp-meta">
              <span className={`weq-totp-error${totpError ? ' is-show' : ''}`}>
                {totpError ?? '验证码每 30 秒自动刷新'}
              </span>
              <span className="weq-totp-countdown" aria-hidden>
                <span
                  className="weq-totp-countdown-bar"
                  style={{ width: `${(secondsLeft / TOTP_STEP_SECONDS) * 100}%` }}
                />
                <span className="weq-totp-countdown-num">{secondsLeft}s</span>
              </span>
            </div>

            {totpStatus?.configured !== true ? (
              <p className="weq-lock-tip">验证器尚未配置，请在 设置 → 应用锁 中完成绑定。</p>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
