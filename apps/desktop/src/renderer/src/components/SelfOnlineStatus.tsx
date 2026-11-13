import {
  cloneElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { SelfProfileEditingContext } from './SelfProfileField';
import { useSelfProfileFields } from './SelfProfileFields';
import '../styles/self-online-status.css';

/** 状态沿用公共身份区展示，只有本人完整资料页挂载就地编辑浮层。 */
export function SelfOnlineStatus({ children }: { children: ReactNode }) {
  const self = useSelfProfileFields();
  const editable = useContext(SelfProfileEditingContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const canEdit = editable && self?.fields.status && !self.fields.status.props.disabled;
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLElement>('.weq-self-field-inputs select, .weq-self-field-inputs input')
      ?.focus();
    return () => trigger.current?.focus({ preventScroll: true });
  }, [open]);
  function close() {
    self?.fields.extendedStatus?.props.onCancel?.();
    setOpen(false);
  }
  return (
    <>
      {canEdit || open ? (
        <button
          ref={trigger}
          type="button"
          className="weq-self-online-status weq-profile-data-action"
          aria-label="编辑在线状态"
          title="编辑在线状态"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={(event) => {
            const selection = event.currentTarget.ownerDocument.getSelection();
            if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
            if (open) close();
            else if (canEdit) setOpen(true);
          }}
        >
          {children}
        </button>
      ) : (
        children
      )}
      {open ? (
        <OverlayLayer
          presentation="popover"
          anchor={trigger.current}
          anchorPlacement="side"
          className="weq-self-status-layer"
          onClose={close}
        >
          <section
            ref={panel}
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
            {(['status', 'extendedStatus'] as const).map((field) => {
              const editor = self?.fields[field];
              return editor
                ? cloneElement(editor, {
                    key: field,
                    editorOnly: true,
                    onEditingChange: (editing) => {
                      if (!editing) close();
                    },
                  })
                : null;
            })}
          </section>
        </OverlayLayer>
      ) : null}
    </>
  );
}
