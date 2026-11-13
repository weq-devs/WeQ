import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { ContactRow } from './contactProfile/ContactRow';
import '../styles/self-profile-card.css';

export type Save = (action: () => Promise<boolean>) => Promise<boolean>;
const SaveContext = createContext<Save>((action) => action());
export const SelfProfileEditingContext = createContext(true);
export const useSelfProfileSave = () => useContext(SaveContext);

export function SelfProfileField({
  label,
  value,
  disabled,
  children,
  onCancel,
  renderValue,
  inline = false,
  afterSave,
  editorFooter,
  onEditingChange,
  unframed = false,
  valueHasAction = false,
}: {
  label: string;
  value: ReactNode;
  disabled?: boolean;
  children: ReactNode | ((save: Save) => ReactNode);
  onCancel?: () => void;
  renderValue?: (value: ReactNode) => ReactNode;
  inline?: boolean;
  afterSave?: () => Promise<boolean>;
  editorFooter?: ReactNode;
  onEditingChange?: (editing: boolean) => void;
  unframed?: boolean;
  valueHasAction?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const editable = useContext(SelfProfileEditingContext);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const edit = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (editing)
      editor.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
  }, [editing]);
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      edit.current?.focus();
    }
  }, [editing]);
  function close() {
    restoreFocus.current = true;
    setEditing(false);
    onEditingChange?.(false);
  }
  const save: Save = async (action) => {
    if (running.current || !mounted.current) return false;
    running.current = true;
    setPending(true);
    try {
      const contentSaved = await action();
      const ok = contentSaved && mounted.current && (!afterSave || (await afterSave()));
      if (ok && mounted.current) close();
      return ok;
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const canEdit = editable && !disabled;
  const structured = Boolean(
    valueHasAction ||
      unframed ||
      (!renderValue && typeof value !== 'string' && typeof value !== 'number' && value != null),
  );
  const content = renderValue ? renderValue(value) : (value ?? '尚未读取');
  const display = (
    <div className="weq-self-field-display">
      {canEdit && !structured ? (
        <button
          ref={edit}
          type="button"
          className="weq-self-field-value weq-profile-data-action"
          data-privacy-sensitive
          title={`编辑${label}`}
          aria-label={`编辑${label}`}
          onClick={(event) => {
            const selection = event.currentTarget.ownerDocument.getSelection();
            if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
            setEditing(true);
            onEditingChange?.(true);
          }}
        >
          <span>{content}</span>
        </button>
      ) : (
        <div className="weq-self-field-value" data-privacy-sensitive>
          {content}
        </div>
      )}
    </div>
  );
  return (
    <div className={`weq-self-field${inline ? ' is-inline' : ''}`} data-profile-field={label}>
      {!editing ? (
        inline || unframed ? (
          display
        ) : (
          <ContactRow label={label}>{display}</ContactRow>
        )
      ) : (
        <div
          ref={editor}
          className="weq-self-field-editor"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              if (!running.current) {
                onCancel?.();
                close();
              }
            }
          }}
        >
          <fieldset disabled={pending} className="weq-self-field-inputs">
            <SaveContext.Provider value={save}>
              {typeof children === 'function' ? children(save) : children}
            </SaveContext.Provider>
            {editorFooter}
          </fieldset>
          <button
            type="button"
            className="weq-self-field-cancel"
            title={`取消编辑${label}`}
            aria-label={`取消编辑${label}`}
            disabled={pending}
            onClick={() => {
              onCancel?.();
              close();
            }}
          >
            <X size={14} />
            <span>取消</span>
          </button>
        </div>
      )}
    </div>
  );
}
