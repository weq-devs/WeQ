/**
 * Lightweight auto-dismiss toasts — the success/notice counterpart to the modal
 * {@link DialogHost} (which is reserved for errors / confirms that block).
 *
 *   - useToast()    imperative store: push({ tone, title, message })
 *   - <ToastHost/>  mounted once near the root; stacks + auto-dismisses toasts
 *
 * Kept deliberately tiny (no portal, no deps beyond zustand + lucide) so any
 * call site can fire a transient "保存成功" without wiring a modal.
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { create } from 'zustand';
import { Check, Info, X } from 'lucide-react';

export type ToastTone = 'success' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: ReactNode;
  /** Auto-dismiss delay in ms. */
  ttl: number;
}

interface ToastStore {
  toasts: Toast[];
  seq: number;
  push(input: { tone?: ToastTone; title: string; message?: ReactNode; ttl?: number }): void;
  dismiss(id: number): void;
}

export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],
  seq: 0,
  push({ tone = 'success', title, message, ttl = 2600 }) {
    const id = get().seq + 1;
    set({ seq: id, toasts: [...get().toasts, { id, tone, title, message, ttl }] });
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

const TONE_ICON: Record<ToastTone, ReactElement> = {
  success: <Check size={16} strokeWidth={2.2} aria-hidden />,
  info: <Info size={16} strokeWidth={2} aria-hidden />,
};

function ToastRow({ toast }: { toast: Toast }): ReactElement {
  const dismiss = useToast((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.ttl);
    return () => clearTimeout(timer);
  }, [toast.id, toast.ttl, dismiss]);

  return (
    <div className={`weq-toast weq-toast-${toast.tone} weq-anim-pop`} role="status">
      <span className="weq-toast-icon">{TONE_ICON[toast.tone]}</span>
      <div className="weq-toast-text">
        <strong className="weq-toast-title">{toast.title}</strong>
        {toast.message ? <span className="weq-toast-msg">{toast.message}</span> : null}
      </div>
      <button className="weq-toast-x" onClick={() => dismiss(toast.id)} aria-label="关闭">
        <X size={13} strokeWidth={2} aria-hidden />
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
