/**
 * Database-key input.
 *
 *   - new mode      editable; masked with a reveal (eye) toggle. The action
 *                   button reads "获取密钥" until the value is a complete key
 *                   (16 ascii on PC / 32 hex on Android), then flips to "进入".
 *   - existing mode read-only; masked with a copy button (eye → copy). Action
 *                   is always "进入".
 *
 * Masking uses `-webkit-text-security` so the real value still lives in the
 * input (paste / select work); revealing just drops the mask.
 */

import { useState, type ReactElement } from 'react';
import { ArrowRight, Check, Copy, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';

/**
 * PC QQ 的 dbkey 是 16 位可打印 ASCII；手机 QQ（安卓备份目录）的是 32 位
 * 十六进制。两种都要放行，否则 32 位密钥会被当成「没填完」而被整个丢掉。
 */
const KEY_LENGTHS = [16, 32];

/** A complete key is 16 or 32 printable-ascii chars. */
export function isCompleteKey(value: string): boolean {
  return KEY_LENGTHS.includes(value.length) && /^[\x20-\x7e]+$/.test(value);
}

/** 人类可读的长度要求，给提示文案用。 */
export const KEY_LEN_HINT = KEY_LENGTHS.join(' / ');

export function KeyField({
  mode,
  value,
  onChange,
  onAction,
  busy,
  online,
}: {
  mode: 'new' | 'existing';
  value: string;
  onChange: (v: string) => void;
  onAction: () => void;
  busy: boolean;
  /** new mode only: whether the selected account appears online (affects label). */
  online?: boolean;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const complete = isCompleteKey(value);
  const empty = value.length === 0;
  // new mode: 获取密钥 until a full key is present; existing: always 进入.
  const isEnter = mode === 'existing' || complete;

  function copy(): void {
    if (!value) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  const placeholder =
    mode === 'existing'
      ? '已保存的数据库密钥'
      : online
        ? '点击获取该账号的数据库密钥'
        : '等待获取 / 填入账号对应的数据库密钥';

  return (
    <div className="weq-keyfield">
      <div className="weq-keyfield-input">
        <KeyRound className="weq-keyfield-lead" size={15} strokeWidth={1.8} aria-hidden />
        <input
          className={`weq-keyfield-text ${!revealed && !empty ? 'weq-mask' : ''}`}
          value={value}
          readOnly={mode === 'existing'}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isEnter && !busy) onAction();
          }}
        />
        {mode === 'existing' ? (
          <button
            type="button"
            className="weq-keyfield-icon"
            onClick={copy}
            title="复制密钥"
            aria-label="复制密钥"
            disabled={empty}
          >
            {copied ? <Check size={15} strokeWidth={1.9} aria-hidden /> : <Copy size={15} strokeWidth={1.8} aria-hidden />}
          </button>
        ) : (
          <button
            type="button"
            className="weq-keyfield-icon"
            onClick={() => setRevealed((r) => !r)}
            title={revealed ? '隐藏密钥' : '显示密钥'}
            aria-label={revealed ? '隐藏密钥' : '显示密钥'}
            disabled={empty}
          >
            {revealed ? <EyeOff size={15} strokeWidth={1.8} aria-hidden /> : <Eye size={15} strokeWidth={1.8} aria-hidden />}
          </button>
        )}
      </div>

      <button
        type="button"
        className="weq-action-primary weq-keyfield-action"
        onClick={onAction}
        disabled={busy || (isEnter && empty)}
      >
        {busy ? (
          <Loader2 className="animate-spin" size={15} strokeWidth={1.8} aria-hidden />
        ) : isEnter ? (
          <ArrowRight size={15} strokeWidth={1.85} aria-hidden />
        ) : (
          <KeyRound size={15} strokeWidth={1.8} aria-hidden />
        )}
        {isEnter ? '进入' : '获取密钥'}
      </button>

      {mode === 'new' && !empty && !complete && (
        <p className="weq-keyfield-hint">
          请填入 {KEY_LEN_HINT} 位数据库密钥（当前 {value.length} 位）
        </p>
      )}
    </div>
  );
}
