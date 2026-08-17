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

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { create } from 'zustand';
import { Check, Info, AlertTriangle, XCircle, X } from 'lucide-react';

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
  dismiss(id: number): void;
}

export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],
  seq: 0,
  push({ tone = 'info', message, detail, title, ttl = 2600 }) {
    const id = get().seq + 1;
    // 向后兼容：如果传了 title，把它当作 message；原 message 当作 detail
    const actualMessage = title || message;
    const actualDetail = title ? message : detail;
    set({ seq: id, toasts: [...get().toasts, { id, tone, message: actualMessage, detail: actualDetail, ttl }] });
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

const TONE_CONFIG: Record<ToastTone, { icon: ReactElement; label: string }> = {
  info: { icon: <Info size={20} strokeWidth={2.5} aria-hidden />, label: '提示' },
  warning: { icon: <AlertTriangle size={20} strokeWidth={2.5} aria-hidden />, label: '警告' },
  error: { icon: <XCircle size={20} strokeWidth={2.5} aria-hidden />, label: '错误' },
  success: { icon: <Check size={20} strokeWidth={2.5} aria-hidden />, label: '成功' },
};

function ToastRow({ toast }: { toast: Toast }): ReactElement {
  const dismiss = useToast((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.ttl);
    return () => clearTimeout(timer);
  }, [toast.id, toast.ttl, dismiss]);

  const config = TONE_CONFIG[toast.tone];

  return (
    <div className={`weq-toast weq-toast-${toast.tone} weq-anim-pop`} role="status">
      <span className="weq-toast-icon">{config.icon}</span>
      <div className="weq-toast-text">
        <strong className="weq-toast-title">{config.label}</strong>
        <span className="weq-toast-msg">{toast.message}</span>
        {toast.detail ? <span className="weq-toast-detail">{toast.detail}</span> : null}
      </div>
      <button className="weq-toast-x" onClick={() => dismiss(toast.id)} aria-label="关闭">
        <X size={14} strokeWidth={2} aria-hidden />
      </button>
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
