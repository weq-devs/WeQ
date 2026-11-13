import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import '../styles/self-online-status.css';

const StatusEditor = lazy(() => import('./SelfOnlineStatusEditor'));

/** 所有本人状态入口共用同一个按需加载的整体编辑器。 */
export function SelfOnlineStatus({
  children,
  uin,
  className,
  title,
}: {
  children: ReactNode;
  uin: string;
  className?: string;
  title?: string;
}) {
  const session = useQQWriteSession('self-online-status-trigger', true);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const canEdit = session.available && !session.busy && session.binding?.expectedAccountUin === uin;
  useEffect(() => setOpen(false), [identity, uin]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    return () => trigger.current?.focus({ preventScroll: true });
  }, [open]);
  function close() {
    setOpen(false);
  }
  return (
    <>
      {canEdit || open ? (
        <button
          ref={trigger}
          type="button"
          className={`weq-self-online-status${className ? ` ${className}` : ''}`}
          aria-label="编辑在线状态"
          title={title || '编辑在线状态'}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={(event) => {
            event.stopPropagation();
            const selection = event.currentTarget.ownerDocument.getSelection();
            if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
            if (open) close();
            else if (canEdit) setOpen(true);
          }}
        >
          {children}
        </button>
      ) : (
        <span className={className} title={title}>
          {children}
        </span>
      )}
      {open && session.binding ? (
        <OverlayLayer
          presentation="popover"
          anchor={trigger.current}
          anchorPlacement="side"
          className="weq-self-status-layer"
          onClose={close}
        >
          <section
            ref={panel}
            tabIndex={-1}
            id={id}
            role="dialog"
            aria-label="修改在线状态"
            className="weq-self-status-dialog"
            data-weq-surface
          >
            <header>
              <h2>在线状态</h2>
              <button
                type="button"
                className="weq-set-iconbtn"
                aria-label="关闭在线状态"
                title="关闭"
                onClick={close}
              >
                <X size={16} />
              </button>
            </header>
            <Suspense fallback={<p role="status">正在读取在线状态…</p>}>
              <StatusEditor key={identity} binding={session.binding} onSaved={close} />
            </Suspense>
          </section>
        </OverlayLayer>
      ) : null}
    </>
  );
}
