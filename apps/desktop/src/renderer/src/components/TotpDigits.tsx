/**
 * TOTP 6 位验证码输入 —— 一格一位数字。
 *
 * 设置页（size="sm"，绑定确认）与解锁弹窗（size="lg"）共用：
 * 输入自动前进、退格回退、支持整段粘贴；输满 6 位自动回调 onComplete。
 * 父组件通过 resetSignal（清空）与 shakeSignal（错误抖动）驱动反馈动画。
 */

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

const DEFAULT_LENGTH = 6;

export function TotpDigits({
  length = DEFAULT_LENGTH,
  size = 'sm',
  disabled = false,
  autoFocus = false,
  resetSignal = 0,
  shakeSignal = 0,
  onComplete,
}: {
  length?: number;
  size?: 'sm' | 'lg';
  disabled?: boolean;
  autoFocus?: boolean;
  /** 数值变化时清空所有格子并回到第一位。 */
  resetSignal?: number;
  /** 数值变化时触发抖动动画（错误反馈）。 */
  shakeSignal?: number;
  onComplete: (code: string) => void;
}): ReactElement {
  const [digits, setDigits] = useState<string[]>(() => Array<string>(length).fill(''));
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [shaking, setShaking] = useState(false);

  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    setDigits(Array<string>(length).fill(''));
    inputRefs.current[0]?.focus();
  }, [resetSignal, length]);

  useEffect(() => {
    if (shakeSignal === 0) return undefined;
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 480);
    return () => window.clearTimeout(timer);
  }, [shakeSignal]);

  function focusAt(index: number): void {
    inputRefs.current[index]?.focus();
  }

  function applyDigits(next: string[]): void {
    setDigits(next);
    if (next.every((d) => d !== '')) {
      completeRef.current(next.join(''));
    }
  }

  function handleChange(index: number, raw: string): void {
    const value = raw.replace(/\D/g, '').slice(-1);
    if (!value) return;
    const next = [...digits];
    next[index] = value;
    applyDigits(next);
    if (index < length - 1) focusAt(index + 1);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Backspace') return;
    event.preventDefault();
    if (digits[index]) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
    } else if (index > 0) {
      const next = [...digits];
      next[index - 1] = '';
      setDigits(next);
      focusAt(index - 1);
    }
  }

  function handlePaste(index: number, event: ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    event.preventDefault();
    const next = [...digits];
    for (let i = 0; i < pasted.length && index + i < length; i += 1) {
      next[index + i] = pasted[i]!;
    }
    applyDigits(next);
    const target = Math.min(index + pasted.length, length - 1);
    focusAt(target);
  }

  return (
    <div
      className={`weq-totp-digits is-${size}${shaking ? ' is-shake' : ''}`}
      role="group"
      aria-label="6 位验证码"
    >
      {digits.map((digit, index) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的数字格子按位置渲染,不会重排
          key={index}
          ref={(el) => {
            inputRefs.current[index] = el;
          }}
          className="weq-totp-digit"
          value={digit}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={2}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`第 ${index + 1} 位验证码`}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={(e) => handlePaste(index, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
