/**
 * App-wide dialog primitives — replaces native `alert` / `confirm`.
 *
 *   - <Modal>          low-level portal + overlay + ESC handling + animation
 *   - useDialog()      imperative store: showError / showConfirm (Promise)
 *   - <DialogHost/>    mounted once near the root; renders the active dialog
 *
 * Tone-aware: error / warning / info pick the accent colour. Confirm dialogs
 * resolve their Promise with the user's choice so call sites can `await`.
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AlertTriangle, Info, ShieldAlert, X } from 'lucide-react';

export type DialogTone = 'error' | 'warning' | 'info';

interface DialogRequest {
  id: number;
  tone: DialogTone;
  title: string;
  message: ReactNode;
  /** When set, this is a confirm dialog; resolve receives the choice. */
  confirm?: { okLabel: string; cancelLabel: string; resolve: (ok: boolean) => void };
  /** When false, no close affordance (used for fatal native errors). */
  dismissible: boolean;
}

interface DialogStore {
  current: DialogRequest | null;
  seq: number;
  showError(title: string, message: ReactNode, opts?: { dismissible?: boolean }): void;
  showInfo(title: string, message: ReactNode): void;
  confirm(title: string, message: ReactNode, opts?: { okLabel?: string; cancelLabel?: string; tone?: DialogTone }): Promise<boolean>;
  close(): void;
}

export const useDialog = create<DialogStore>((set, get) => ({
  current: null,
  seq: 0,
  showError(title, message, opts) {
    const id = get().seq + 1;
    set({ seq: id, current: { id, tone: 'error', title, message, dismissible: opts?.dismissible ?? true } });
  },
  showInfo(title, message) {
    const id = get().seq + 1;
    set({ seq: id, current: { id, tone: 'info', title, message, dismissible: true } });
  },
  confirm(title, message, opts) {
    return new Promise<boolean>((resolve) => {
      const id = get().seq + 1;
      set({
        seq: id,
        current: {
          id,
          tone: opts?.tone ?? 'warning',
          title,
          message,
          dismissible: true,
          confirm: {
            okLabel: opts?.okLabel ?? '确定',
            cancelLabel: opts?.cancelLabel ?? '取消',
            resolve,
          },
        },
      });
    });
  },
  close() {
    set({ current: null });
  },
}));

const TONE_ICON: Record<DialogTone, ReactElement> = {
  error: <ShieldAlert size={20} strokeWidth={1.85} aria-hidden />,
  warning: <AlertTriangle size={20} strokeWidth={1.85} aria-hidden />,
  info: <Info size={20} strokeWidth={1.85} aria-hidden />,
};

/** Low-level modal shell. Use directly for bespoke dialogs (e.g. QR login). */
export function Modal({
  onClose,
  children,
  labelledBy,
  width,
}: {
  onClose?: () => void;
  children: ReactNode;
  labelledBy?: string;
  width?: number | string;
}): ReactElement | null {
  useEffect(() => {
    if (typeof document === 'undefined' || !onClose) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="weq-dialog-layer weq-anim-fade" onMouseDown={onClose}>
      <div
        className="weq-modal weq-anim-pop"
        role="dialog"
        aria-modal="true"
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        style={width ? { width } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Mount once. Renders whatever the imperative store currently holds. */
export function DialogHost(): ReactElement | null {
  const current = useDialog((s) => s.current);
  const close = useDialog((s) => s.close);

  if (!current) return null;

  const handleClose = current.dismissible
    ? () => {
        current.confirm?.resolve(false);
        close();
      }
    : undefined;

  return (
    <Modal onClose={handleClose} labelledBy="weq-dialog-title" width={368}>
      <div className={`weq-dialog weq-dialog-${current.tone}`}>
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">{TONE_ICON[current.tone]}</span>
          <h3 id="weq-dialog-title" className="weq-dialog-title">
            {current.title}
          </h3>
          {handleClose && (
            <button className="weq-dialog-x" onClick={handleClose} aria-label="关闭">
              <X size={16} strokeWidth={1.9} aria-hidden />
            </button>
          )}
        </div>
        <div className="weq-dialog-body">{current.message}</div>
        <div className="weq-dialog-foot">
          {current.confirm ? (
            <>
              <button
                className="weq-action-soft"
                onClick={() => {
                  current.confirm?.resolve(false);
                  close();
                }}
              >
                {current.confirm.cancelLabel}
              </button>
              <button
                className="weq-action-primary"
                onClick={() => {
                  current.confirm?.resolve(true);
                  close();
                }}
              >
                {current.confirm.okLabel}
              </button>
            </>
          ) : (
            handleClose && (
              <button className="weq-action-primary" onClick={handleClose}>
                我知道了
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}
