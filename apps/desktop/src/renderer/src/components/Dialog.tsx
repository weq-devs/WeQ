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

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRenderDocument } from '../lib/renderDocument';
import { useTabActive } from './RetainedTabs';
import { create } from 'zustand';
import { AlertTriangle, Info, Lock, ShieldAlert, X } from 'lucide-react';
import { OverlayLayerContext, useOverlayLayer } from '../lib/overlayStack';
import { OverlayAnchorContext, useOverlayAnchor } from '../lib/overlayAnchor';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { WorkspacePage } from './WorkspacePages';
import { WindowSurface } from './WindowSurface';
import { useSurfaceOutside } from '../lib/surfaceOutside';
import '../styles/dialog-layout.css';

export type DialogTone = 'error' | 'warning' | 'info';

interface DialogRequest {
  id: number;
  tone: DialogTone;
  title: string;
  message: ReactNode;
  /** When set, this is a confirm dialog; resolve receives the choice. */
  confirm?: { okLabel: string; cancelLabel: string; resolve: (ok: boolean) => void };
  /** When set, this is a secure password prompt; resolve receives the value or null. */
  password?: {
    okLabel: string;
    cancelLabel: string;
    placeholder: string;
    resolve: (value: string | null) => void;
  };
  /** When false, no close affordance (used for fatal native errors). */
  dismissible: boolean;
}

interface DialogStore {
  current: DialogRequest | null;
  seq: number;
  showError(title: string, message: ReactNode, opts?: { dismissible?: boolean }): void;
  showInfo(title: string, message: ReactNode): void;
  confirm(
    title: string,
    message: ReactNode,
    opts?: { okLabel?: string; cancelLabel?: string; tone?: DialogTone },
  ): Promise<boolean>;
  promptPassword(
    title: string,
    message: ReactNode,
    opts?: { okLabel?: string; cancelLabel?: string; placeholder?: string },
  ): Promise<string | null>;
  close(): void;
}

export const useDialog = create<DialogStore>((set, get) => ({
  current: null,
  seq: 0,
  showError(title, message, opts) {
    const id = get().seq + 1;
    set({
      seq: id,
      current: { id, tone: 'error', title, message, dismissible: opts?.dismissible ?? true },
    });
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
  promptPassword(title, message, opts) {
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
  className,
  layerClassName,
  open = true,
  presentation = 'modal',
  title,
  anchor,
  centered = false,
  dismissOnOutside = true,
  portalTarget,
}: {
  onClose?: () => void;
  children: ReactNode;
  labelledBy?: string;
  width?: number | string;
  /** Extra class for the `.weq-modal` card itself (e.g. lock-screen theming). */
  className?: string;
  /** Extra class for the full-screen overlay layer. */
  layerClassName?: string;
  /** 关闭时保留子树，后台任务和工具内会话不因遮罩收起而销毁。 */
  open?: boolean;
  presentation?: 'modal' | 'panel' | 'popover' | 'page' | 'sidecar' | 'floating' | 'anchored';
  title?: string;
  anchor?: HTMLElement | null;
  /** 强制居中遮罩，不沿用最近的触发点。 */
  centered?: boolean;
  /** 安全验证、编辑正文等流程可显式禁用点外关闭。 */
  dismissOnOutside?: boolean;
  portalTarget?: Element | null;
}): ReactElement | null {
  const document = useRenderDocument();
  const tabActive = useTabActive();
  const active = tabActive && open;
  const windowed = presentation === 'floating' || presentation === 'anchored';
  const layer = useOverlayLayer(active && !windowed);
  const ref = useRef<HTMLDivElement>(null);
  const placement = useOverlayAnchor(
    ref,
    active && !windowed,
    presentation === 'popover' && !centered,
    anchor,
  );
  useSurfaceEscape(
    ref,
    onClose,
    active && !windowed && presentation !== 'page' && presentation !== 'sidecar',
    presentation === 'modal',
  );
  useSurfaceOutside(
    ref,
    onClose,
    active &&
      !windowed &&
      dismissOnOutside &&
      presentation !== 'page' &&
      presentation !== 'sidecar',
    { scrim: true, anchor: placement.anchor?.element },
  );

  if (typeof document === 'undefined') return null;
  if (windowed)
    return (
      <WindowSurface
        mode={presentation}
        open={open}
        anchor={anchor}
        width={width}
        labelledBy={labelledBy}
        title={title}
        className={className}
        onClose={onClose}
        dismissOnOutside={dismissOnOutside}
      >
        {children}
      </WindowSurface>
    );
  if (presentation === 'page' || presentation === 'sidecar')
    return active ? (
      <WorkspacePage
        title={title ?? '详情'}
        onClose={onClose}
        placement={presentation === 'sidecar' ? 'sidecar' : 'main'}
      >
        <div
          className={`weq-modal${className ? ` ${className}` : ''}`}
          aria-labelledby={labelledBy}
        >
          {children}
        </div>
      </WorkspacePage>
    ) : null;

  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      className={`weq-dialog-layer weq-anim-fade${layerClassName ? ` ${layerClassName}` : ''}${presentation !== 'modal' ? ' weq-nonmodal-layer' : ''}${presentation === 'panel' ? ' weq-centered-panel' : ''}${presentation === 'popover' ? ' is-popover' : ''}${placement.position ? ' is-anchored-popover' : ''}`}
      hidden={!active}
      inert={!active}
      style={{ ...placement.position, zIndex: layer, display: active ? undefined : 'none' }}
      onPointerDownCapture={placement.capture}
      onClickCapture={placement.capture}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className={`weq-modal weq-anim-pop${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal={presentation === 'modal' ? true : undefined}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        style={width ? { width } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <OverlayLayerContext.Provider value={layer}>
          <OverlayAnchorContext.Provider value={placement.trigger}>
            {children}
          </OverlayAnchorContext.Provider>
        </OverlayLayerContext.Provider>
      </div>
    </div>,
    portalTarget ?? document.body,
  );
}

/** Mount once. Renders whatever the imperative store currently holds. */
export function DialogHost(): ReactElement | null {
  const current = useDialog((s) => s.current);
  const close = useDialog((s) => s.close);

  if (!current) return null;

  const isPasswordPrompt = Boolean(current?.password);

  const handleClose = current.dismissible
    ? () => {
        current.confirm?.resolve(false);
        current.password?.resolve(null);
        close();
      }
    : undefined;

  return (
    <Modal
      presentation={
        current.confirm || current.password || !current.dismissible ? 'modal' : 'popover'
      }
      // 确认 / 密码框属于全局交互，不能被“最后一次点击的按钮”锚定到任务窗、浮窗里，
      // 否则会贴着触发点落在浮窗下缘（观感上像被浮窗压住）。
      centered={Boolean(current.confirm || current.password || !current.dismissible)}
      onClose={handleClose}
      dismissOnOutside={!current.confirm && !current.password}
      labelledBy="weq-dialog-title"
      width={368}
      className={`weq-message-modal${isPasswordPrompt ? ' weq-password-modal' : ''}`}
    >
      <div
        className={`weq-dialog weq-dialog-${current.tone}${isPasswordPrompt ? ' weq-dialog-password' : ''}`}
      >
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            {isPasswordPrompt ? (
              <Lock size={20} strokeWidth={1.85} aria-hidden />
            ) : (
              TONE_ICON[current.tone]
            )}
          </span>
          <h3 id="weq-dialog-title" className="weq-dialog-title">
            {current.title}
          </h3>
          {handleClose && (
            <button className="weq-dialog-x" onClick={handleClose} aria-label="关闭">
              <X size={16} strokeWidth={1.9} aria-hidden />
            </button>
          )}
        </div>
        {current.password ? (
          <PasswordDialogBody
            key={current.id}
            request={current}
            onResolve={(value) => {
              current.password?.resolve(value);
              close();
            }}
          />
        ) : (
          <>
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
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * 密码输入体。按 `key={dialog.id}` 挂载，每个对话框都是全新 state——
 * 连续弹多个密码框（如内存扫描 + 抓包提权）时，不会把上一个框的旧值
 * 提交给 sudo（旧值会导致 sudo 收到错误密码：Sorry, try again）。
 */
function PasswordDialogBody({
  request,
  onResolve,
}: {
  request: DialogRequest;
  onResolve: (value: string | null) => void;
}): ReactElement {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = (): void => {
    if (!value) return;
    onResolve(value);
  };

  return (
    <>
      <div className="weq-dialog-body weq-password-body">
        <div>{request.message}</div>
        <input
          ref={inputRef}
          className="weq-password-input"
          type="password"
          value={value}
          placeholder={request.password?.placeholder ?? '请输入密码'}
          autoComplete="current-password"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </div>
      <div className="weq-dialog-foot">
        <button
          className="weq-action-soft"
          onClick={() => {
            onResolve(null);
          }}
        >
          {request.password?.cancelLabel ?? '取消'}
        </button>
        <button className="weq-action-primary" disabled={!value} onClick={submit}>
          {request.password?.okLabel ?? '确定'}
        </button>
      </div>
    </>
  );
}
