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
import { RenderDocumentContext, useRenderDocument } from '../lib/renderDocument';
import { useTabActive } from './RetainedTabs.shared';
import { AlertTriangle, Info, Lock, ShieldAlert, X } from 'lucide-react';
import { OverlayLayerContext, useOverlayLayerScope } from '../lib/overlayStack';
import { OverlayAnchorContext, useOverlayAnchor } from '../lib/overlayAnchor.shared';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { WorkspacePage } from './WorkspacePages';
import { WindowSurface } from './WindowSurface';
import { useSurfaceOutside } from '../lib/surfaceOutside';
import { useMobileWebViewport } from '../hooks/useMobileWebViewport';
import { IS_WEB } from '../lib/target.shared';
import '../styles/dialog-layout.css';
import { ContactFieldHistoryBoundary } from '../lib/contactFieldHistoryContext';
import { type DialogTone, useDialog, type DialogRequest } from './Dialog.shared';

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
  anchorPlacement,
  centered = false,
  dismissOnOutside = true,
  portalTarget,
  mobileChrome = false,
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
  anchorPlacement?: 'above' | 'below' | 'side';
  /** 强制居中遮罩，不沿用最近的触发点。 */
  centered?: boolean;
  /** 安全验证、编辑正文等流程可显式禁用点外关闭。 */
  dismissOnOutside?: boolean;
  portalTarget?: Element | null;
  mobileChrome?: boolean;
}): ReactElement | null {
  const document = useRenderDocument();
  const tabActive = useTabActive();
  const active = tabActive && open;
  const windowed = presentation === 'floating' || presentation === 'anchored';
  const { layer, scope } = useOverlayLayerScope(active && !windowed);
  const ref = useRef<HTMLDivElement>(null);
  useMobileWebViewport(
    ref,
    IS_WEB && active && !windowed && presentation !== 'page' && presentation !== 'sidecar',
  );
  const placement = useOverlayAnchor(
    ref,
    active && !windowed,
    presentation === 'popover' && !centered,
    anchor,
    anchorPlacement,
  );
  useSurfaceEscape(
    ref,
    onClose,
    active && !windowed && presentation !== 'page' && presentation !== 'sidecar',
    presentation === 'modal',
    100,
    scope,
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
        <ContactFieldHistoryBoundary>{children}</ContactFieldHistoryBoundary>
      </WindowSurface>
    );
  if (presentation === 'page' || presentation === 'sidecar')
    return active ? (
      <WorkspacePage
        title={title ?? '详情'}
        onClose={onClose}
        placement={presentation === 'sidecar' ? 'sidecar' : 'main'}
        mobileChrome={mobileChrome}
      >
        <div
          className={`weq-modal${className ? ` ${className}` : ''}`}
          aria-labelledby={labelledBy}
        >
          <ContactFieldHistoryBoundary>{children}</ContactFieldHistoryBoundary>
        </div>
      </WorkspacePage>
    ) : null;

  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      className={`weq-dialog-layer weq-anim-fade${IS_WEB ? ' weq-web-dialog-layer' : ''}${layerClassName ? ` ${layerClassName}` : ''}${presentation !== 'modal' ? ' weq-nonmodal-layer' : ''}${presentation === 'panel' ? ' weq-centered-panel' : ''}${presentation === 'popover' ? ' is-popover' : ''}${placement.position ? ' is-anchored-popover' : ''}`}
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
        <OverlayLayerContext.Provider value={scope}>
          <OverlayAnchorContext.Provider value={placement.trigger}>
            <ContactFieldHistoryBoundary>{children}</ContactFieldHistoryBoundary>
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

  useEffect(() => () => useDialog.getState().close(), []);
  useEffect(() => {
    const id = current?.id;
    const view = current?.ownerDocument?.defaultView;
    if (!view || id === undefined) return;
    const dismiss = () => close(id);
    if (view.closed) {
      dismiss();
      return;
    }
    view.addEventListener('beforeunload', dismiss);
    view.addEventListener('unload', dismiss);
    return () => {
      view.removeEventListener('beforeunload', dismiss);
      view.removeEventListener('unload', dismiss);
    };
  }, [current, close]);

  if (!current) return null;

  const isPasswordPrompt = Boolean(current?.password);

  const handleClose = current.dismissible
    ? () => {
        current.confirm?.resolve(false);
        current.password?.resolve(null);
        close(current.id);
      }
    : undefined;

  return (
    <RenderDocumentContext.Provider value={current.ownerDocument ?? null}>
      <Modal
        key={current.id}
        presentation={
          current.confirm || current.password || !current.dismissible ? 'modal' : 'panel'
        }
        // 全局消息框始终相对窗口居中，不沿用任务窗或浮窗里的最后一次点击位置。
        centered
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
                close(current.id);
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
                        close(current.id);
                      }}
                    >
                      {current.confirm.cancelLabel}
                    </button>
                    <button
                      className="weq-action-primary"
                      data-danger={current.confirm.danger}
                      onClick={() => {
                        current.confirm?.resolve(true);
                        close(current.id);
                      }}
                    >
                      {current.confirm.okLabel}
                    </button>
                  </>
                ) : (
                  handleClose && (
                    <button className="weq-action-soft" onClick={handleClose}>
                      我知道了
                    </button>
                  )
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </RenderDocumentContext.Provider>
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
export type { ConfirmDialogOptions, DialogTone, DangerLevel } from './Dialog.shared';
