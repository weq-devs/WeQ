/**
 * 应用锁 → WeQ 验证器绑定弹窗。
 *
 * 两步流程：① 扫描二维码 / 复制密钥，在验证器 App 中添加「WeQ」条目；
 * ② 回填 App 中显示的 6 位动态验证码完成绑定。
 * 弹窗挂载即生成待确认密钥（不落盘），关闭（成功 / 取消 / 点遮罩）后由卸载
 * 清理丢弃，避免出现「已生成但没录入」的悬空密钥。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Loader2,
  LockKeyhole,
  RefreshCw,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { Modal, useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { shellBridge } from '../../lib/target';
import { TotpDigits } from '../TotpDigits';

type TotpStatus = Awaited<ReturnType<typeof window.weq.totp.getStatus>>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface TotpSetupState {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

type BindStep = 'scan' | 'verify';

export function TotpBindDialog({
  onClose,
  onBound,
}: {
  onClose: () => void;
  /** 绑定成功后回调（已刷新验证器状态）。 */
  onBound?: (status: TotpStatus) => void;
}): ReactElement | null {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const [setup, setSetup] = useState<TotpSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [step, setStep] = useState<BindStep>('scan');
  const [genKey, setGenKey] = useState(0);
  const [shakeSignal, setShakeSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);

  const setupRef = useRef<TotpSetupState | null>(null);
  useEffect(() => {
    setupRef.current = setup;
  }, [setup]);

  // 卸载即丢弃尚未确认的待绑定密钥（verify 成功后 pendingSecret 已清空，调用无副作用）。
  useEffect(() => {
    return () => {
      if (setupRef.current) {
        void shellBridge()
          ?.totp.cancelSetup()
          .catch(() => {});
      }
    };
  }, []);

  // 挂载即生成密钥；genKey 变化时（失败重试）重新生成。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const b = shellBridge();
      if (!b) return;
      setBusy(true);
      setError(null);
      try {
        const res = await b.totp.generateSetup();
        const qrDataUrl = await QRCode.toDataURL(res.otpauthUrl, {
          width: 208,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#0f2d4c', light: '#ffffff' },
        });
        if (alive) setSetup({ secret: res.secret, otpauthUrl: res.otpauthUrl, qrDataUrl });
      } catch (e) {
        if (alive) setError(errMsg(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [genKey]);

  function handleClose(): void {
    if (busy || success) return;
    onClose();
  }

  async function onVerify(code: string): Promise<void> {
    const b = shellBridge();
    if (!b || busy || success) return;
    setBusy(true);
    setError(null);
    try {
      const res = await b.totp.verify(code);
      if (res.ok) {
        setSuccess(true);
        setResetSignal((s) => s + 1);
        const status = await b.totp.getStatus().catch(() => null);
        if (status) onBound?.(status);
        window.setTimeout(() => onClose(), 1200);
      } else {
        setError(res.error ?? '验证码错误，请重试。');
        setShakeSignal((s) => s + 1);
        setResetSignal((s) => s + 1);
      }
    } catch (e) {
      setError(errMsg(e));
      setShakeSignal((s) => s + 1);
      setResetSignal((s) => s + 1);
    } finally {
      setBusy(false);
    }
  }

  async function copySecret(): Promise<void> {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      pushToast({ tone: 'success', title: '已复制', message: '验证器密钥已复制到剪贴板' });
    } catch (e) {
      showError('复制失败', errMsg(e));
    }
  }

  const doneStep1 = step === 'verify';
  const doneStep2 = success;

  return (
    <Modal onClose={handleClose} width={420} labelledBy="weq-applock-bind-title">
      <div className="weq-applock-bind">
        <header className="weq-applock-bind-head">
          <div className="weq-applock-bind-title">
            <span className="weq-applock-bind-icon">
              <LockKeyhole size={16} strokeWidth={1.8} aria-hidden />
            </span>
            <h3 id="weq-applock-bind-title">绑定 WeQ 验证器</h3>
          </div>
          <button
            type="button"
            className="weq-applock-bind-x"
            aria-label="关闭"
            onClick={handleClose}
            disabled={busy || success}
          >
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </header>

        {!success ? (
          <ol className="weq-applock-bind-steps" aria-label="绑定步骤">
            <li
              className={`weq-applock-bind-step${step === 'scan' ? ' is-active' : ''}${doneStep1 ? ' is-done' : ''}`}
            >
              <span className="weq-applock-bind-step-num" aria-hidden>
                {doneStep1 ? <Check size={12} strokeWidth={2.6} /> : 1}
              </span>
              扫描二维码
            </li>
            <li className="weq-applock-bind-step-sep" aria-hidden />
            <li
              className={`weq-applock-bind-step${step === 'verify' ? ' is-active' : ''}${doneStep2 ? ' is-done' : ''}`}
            >
              <span className="weq-applock-bind-step-num" aria-hidden>
                {doneStep2 ? <Check size={12} strokeWidth={2.6} /> : 2}
              </span>
              输入验证码
            </li>
          </ol>
        ) : null}

        <div className="weq-applock-bind-body">
          {success ? (
            <div className="weq-applock-bind-success">
              <CheckCircle2 size={36} strokeWidth={1.6} aria-hidden />
              <strong>绑定成功</strong>
              <small>验证器已生效，解锁时输入 App 中的 6 位动态验证码即可。</small>
            </div>
          ) : step === 'scan' ? (
            <div className="weq-applock-bind-scan">
              <div className="weq-applock-bind-qr">
                {setup ? (
                  <img src={setup.qrDataUrl} alt="验证器绑定二维码" width={208} height={208} />
                ) : (
                  <div className="weq-applock-bind-qr-loading">
                    {error ? (
                      <AlertTriangle size={22} strokeWidth={1.8} aria-hidden />
                    ) : (
                      <Loader2 size={22} className="weq-spin" aria-hidden />
                    )}
                  </div>
                )}
              </div>
              <p className="weq-applock-bind-tip">
                打开验证器 App（Google Authenticator / Microsoft Authenticator /
                1Password），扫描上方二维码添加「WeQ」条目；也可以复制密钥手动输入。
              </p>
              <div className="weq-applock-secret">
                <code>{setup?.secret ?? '正在生成…'}</code>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={!setup || busy}
                  onClick={() => void copySecret()}
                >
                  <Copy size={13} aria-hidden />
                  复制
                </button>
              </div>
              {error ? (
                <p className="weq-applock-error">
                  <AlertTriangle size={13} aria-hidden />
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="weq-applock-bind-verify">
              <p className="weq-applock-bind-tip">
                在验证器 App 中找到「WeQ」条目，输入当前显示的 6 位动态验证码完成绑定。
              </p>
              <TotpDigits
                size="sm"
                autoFocus
                disabled={busy}
                resetSignal={resetSignal}
                shakeSignal={shakeSignal}
                onComplete={(code) => void onVerify(code)}
              />
              {error ? (
                <p className="weq-applock-error">
                  <AlertTriangle size={13} aria-hidden />
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {!success ? (
          <footer className="weq-applock-bind-foot">
            {step === 'scan' ? (
              <>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy}
                  onClick={handleClose}
                >
                  取消
                </button>
                {!setup && error ? (
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={busy}
                    onClick={() => setGenKey((k) => k + 1)}
                  >
                    <RefreshCw size={13} aria-hidden />
                    重试
                  </button>
                ) : (
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={!setup || busy}
                    onClick={() => setStep('verify')}
                  >
                    {setup ? (
                      <>
                        下一步
                        <ChevronRight size={13} aria-hidden />
                      </>
                    ) : (
                      <>
                        <Loader2 size={13} className="weq-spin" aria-hidden />
                        正在生成
                      </>
                    )}
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy}
                  onClick={() => setStep('scan')}
                >
                  上一步
                </button>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={busy}
                  onClick={handleClose}
                >
                  取消
                </button>
              </>
            )}
          </footer>
        ) : null}
      </div>
    </Modal>
  );
}
