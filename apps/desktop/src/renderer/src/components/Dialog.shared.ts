/**
 * App-wide dialog primitives — replaces native `alert` / `confirm`.
 *
 *   - <Modal>          low-level portal + overlay + ESC handling + animation
 *   - useDialog()      imperative store: showError / confirm / promptPassword
 *   - <DialogHost/>    mounted once near the root; renders the active dialog
 *
 * Tone-aware: error / warning / info pick the accent colour. Confirm dialogs
 * resolve their Promise with the user's choice so call sites can `await`.
 */

import type { ReactNode } from 'react';
import { create } from 'zustand';
import '../styles/dialog-layout.css';

export type DialogTone = 'error' | 'warning' | 'info';
export type DangerLevel = 'outline' | 'solid';
export interface ConfirmDialogOptions {
  okLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  danger?: DangerLevel;
  ownerDocument?: Document;
}

export interface DialogRequest {
  id: number;
  tone: DialogTone;
  title: string;
  message: ReactNode;
  /** When set, this is a confirm dialog; resolve receives the choice. */
  confirm?: {
    okLabel: string;
    cancelLabel: string;
    danger?: DangerLevel;
    resolve: (ok: boolean) => void;
  };
  /** When set, this is a secure password prompt; resolve receives the value or null. */
  password?: {
    okLabel: string;
    cancelLabel: string;
    placeholder: string;
    resolve: (value: string | null) => void;
  };
  /** When false, no close affordance (used for fatal native errors). */
  dismissible: boolean;
  ownerDocument?: Document;
}

interface DialogStore {
  current: DialogRequest | null;
  seq: number;
  showError(
    title: string,
    message: ReactNode,
    opts?: { dismissible?: boolean; ownerDocument?: Document },
  ): void;
  showInfo(title: string, message: ReactNode, opts?: { ownerDocument?: Document }): void;
  confirm(title: string, message: ReactNode, opts?: ConfirmDialogOptions): Promise<boolean>;
  promptPassword(
    title: string,
    message: ReactNode,
    opts?: {
      okLabel?: string;
      cancelLabel?: string;
      placeholder?: string;
      ownerDocument?: Document;
    },
  ): Promise<string | null>;
  close(id?: number): void;
}

export const useDialog = create<DialogStore>((set, get) => ({
  current: null,
  seq: 0,
  showError(title, message, opts) {
    get().close();
    const id = get().seq + 1;
    set({
      seq: id,
      current: {
        id,
        tone: 'error',
        title,
        message,
        dismissible: opts?.dismissible ?? true,
        ownerDocument: opts?.ownerDocument,
      },
    });
  },
  showInfo(title, message, opts) {
    get().close();
    const id = get().seq + 1;
    set({
      seq: id,
      current: {
        id,
        tone: 'info',
        title,
        message,
        dismissible: true,
        ownerDocument: opts?.ownerDocument,
      },
    });
  },
  confirm(title, message, opts) {
    get().close();
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
          ownerDocument: opts?.ownerDocument,
          confirm: {
            danger: opts?.danger,
            okLabel: opts?.okLabel ?? '确定',
            cancelLabel: opts?.cancelLabel ?? '取消',
            resolve,
          },
        },
      });
    });
  },
  promptPassword(title, message, opts) {
    get().close();
    return new Promise<string | null>((resolve) => {
      const id = get().seq + 1;
      set({
        seq: id,
        current: {
          id,
          tone: 'info',
          title,
          message,
          dismissible: true,
          ownerDocument: opts?.ownerDocument,
          password: {
            okLabel: opts?.okLabel ?? '确定',
            cancelLabel: opts?.cancelLabel ?? '取消',
            placeholder: opts?.placeholder ?? '请输入密码',
            resolve,
          },
        },
      });
    });
  },
  close(id) {
    const current = get().current;
    if (!current || (id !== undefined && current.id !== id)) return;
    set({ current: null });
    current.confirm?.resolve(false);
    current.password?.resolve(null);
  },
}));
