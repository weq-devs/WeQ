/**
 * Lightweight auto-dismiss toasts — the success/notice counterpart to the modal
 * {@link DialogHost} (which is reserved for errors / confirms that block).
 *
 *   - useToast()    imperative store: push({ tone, message })
 *   - <ToastHost/>  mounted once near the root; stacks + auto-dismisses toasts
 *
 * Kept deliberately tiny (no portal, no deps beyond zustand + lucide) so any
 * call site can fire a transient "保存成功" without wiring a modal.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { Check, Info, AlertTriangle, XCircle, X, Copy } from 'lucide-react';

export type ToastTone = 'info' | 'warning' | 'error' | 'success';

interface Toast {
  id: number;
  tone: ToastTone;
  /** 主要内容，显示在标题下方 */
  message: ReactNode;
  /** 可选的次要信息，显示在 message 下方 */
  detail?: ReactNode;
  /** Auto-dismiss delay in ms. */
  ttl: number;
}

interface ToastStore {
  toasts: Toast[];
  /** 正在播放退场动画的 toast id，动画结束后才真正移除 */
  leaving: number[];
  seq: number;
  push(input: {
    tone?: ToastTone;
    /** 主要内容（新写法） */
    message?: ReactNode;
    /** 可选的次要信息 */
    detail?: ReactNode;
    ttl?: number;
    /** 向后兼容：支持旧的 title 字段 */
    title?: string;
  }): void;
  /** 触发退场动画（自动过期 / 点击关闭） */
  dismiss(id: number): void;
  /** 退场动画结束后真正移除 */
  remove(id: number): void;
}

export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],
  leaving: [],
  seq: 0,
  push({ tone = 'info', message, detail, title, ttl = 2600 }) {
    const id = get().seq + 1;
    // 向后兼容：如果传了 title，把它当作 message；原 message 当作 detail
    const actualMessage = title || message;
    const actualDetail = title ? message : detail;
    set({ seq: id, toasts: [...get().toasts, { id, tone, message: actualMessage, detail: actualDetail, ttl }] });
  },
  dismiss(id) {
    if (get().leaving.includes(id)) return;
    set({ leaving: [...get().leaving, id] });
  },
  remove(id) {
    set({
      toasts: get().toasts.filter((t) => t.id !== id),
      leaving: get().leaving.filter((lid) => lid !== id),
    });
  },
}));

const TONE_CONFIG: Record<ToastTone, { icon: ReactElement; label: string }> = {
  info: { icon: <Info size={20} strokeWidth={2.5} aria-hidden />, label: '提示' },
  warning: { icon: <AlertTriangle size={20} strokeWidth={2.5} aria-hidden />, label: '警告' },
  error: { icon: <XCircle size={20} strokeWidth={2.5} aria-hidden />, label: '错误' },
  success: { icon: <Check size={20} strokeWidth={2.5} aria-hidden />, label: '成功' },
};

/** 尽量把 ReactNode 还原成纯文本，用于复制（拿不到字符串时返回空串）。 */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 退场动画时长，与 CSS 里 .weq-toast-leaving 保持一致。 */
const LEAVE_MS = 200;

function ToastRow({ toast }: { toast: Toast }): ReactElement {
  const dismiss = useToast((s) => s.dismiss);
  const remove = useToast((s) => s.remove);
  const leaving = useToast((s) => s.leaving.includes(toast.id));

  // 退场动画结束后真正移除
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => remove(toast.id), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, toast.id, remove]);

  // 倒计时 + 底部进度条（悬停/聚焦时暂停）
  const [remaining, setRemaining] = useState(toast.ttl);
  const [paused, setPaused] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  const pausedAtRef = useRef<number>(0);

  useEffect(() => {
    if (paused || leaving) return;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed >= toast.ttl) {
        dismiss(toast.id);
      } else {
        setRemaining(toast.ttl - elapsed);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [paused, leaving, toast.id, toast.ttl, dismiss]);

  const pause = () => {
    if (paused || leaving) return;
    pausedAtRef.current = Date.now();
    setPaused(true);
  };
  const resume = () => {
    if (!paused) return;
    startedAtRef.current += Date.now() - pausedAtRef.current;
    setPaused(false);
  };

  // 文本溢出检测（message 最多 2 行、detail 最多 1 行），溢出时显示复制按钮
  const textRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const check = () => {
      // 逐个子元素检测：行数限制发生在每个子元素内部，容器自身量不出溢出
      let clipped = false;
      for (const child of Array.from(el.children)) {
        if (child.scrollHeight > child.clientHeight + 1 || child.scrollWidth > child.clientWidth + 1) {
          clipped = true;
          break;
        }
      }
      setTruncated(clipped);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [toast.message, toast.detail]);

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const copyable = textOf(toast.message).length > 0 || (toast.detail != null && textOf(toast.detail).length > 0);

  const handleCopy = async () => {
    const messageText = textOf(toast.message);
    const detailText = toast.detail != null ? textOf(toast.detail) : '';
    const text = detailText ? `${messageText}\n${detailText}` : messageText;
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const config = TONE_CONFIG[toast.tone];
  const progress = toast.ttl > 0 ? Math.max(0, Math.min(100, (remaining / toast.ttl) * 100)) : 0;

  return (
    <div
      className={`weq-toast weq-toast-${toast.tone} weq-anim-pop${leaving ? ' weq-toast-leaving' : ''}`}
      role="status"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
      }}
    >
      <span className="weq-toast-icon" aria-hidden>
        {config.icon}
      </span>
      <div className="weq-toast-text" ref={textRef}>
        <strong className="weq-toast-title">{config.label}</strong>
        <span className="weq-toast-msg">{toast.message}</span>
        {toast.detail ? <span className="weq-toast-detail">{toast.detail}</span> : null}
      </div>
      <div className="weq-toast-actions">
        {truncated && copyable ? (
          <button
            type="button"
            className="weq-toast-action"
            onClick={handleCopy}
            aria-label={copied ? '已复制' : '复制内容'}
            title={copied ? '已复制' : '复制内容'}
          >
            {copied ? <Check size={14} strokeWidth={2.2} aria-hidden /> : <Copy size={14} strokeWidth={2.2} aria-hidden />}
          </button>
        ) : null}
        <button type="button" className="weq-toast-action" onClick={() => dismiss(toast.id)} aria-label="关闭" title="关闭">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <span className="weq-toast-progress" style={{ width: `${progress}%` }} aria-hidden />
    </div>
  );
}

/** Mount once near the root. Stacks active toasts bottom-right. */
export function ToastHost(): ReactElement | null {
  const toasts = useToast((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="weq-toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
