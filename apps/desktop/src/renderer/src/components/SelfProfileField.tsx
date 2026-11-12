import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pencil, X } from 'lucide-react';
import '../styles/self-profile-card.css';

type Save = (action: () => Promise<boolean>) => Promise<boolean>;
const SaveContext = createContext<Save>((action) => action());
export const SelfProfileEditingContext = createContext(true);
export const useSelfProfileSave = () => useContext(SaveContext);

export function SelfProfileField({
  label,
  value,
  disabled,
  children,
  onCancel,
}: {
  label: string;
  value: ReactNode;
  disabled?: boolean;
  children: ReactNode | ((save: Save) => ReactNode);
  onCancel?: () => void;
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
  }
  const save: Save = async (action) => {
    if (running.current || !mounted.current) return false;
    running.current = true;
    setPending(true);
    try {
      const ok = await action();
      if (ok && mounted.current) close();
      return ok;
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <div className="weq-self-field" data-profile-field={label}>
      {!editing ? (
        <div className="weq-self-field-display">
          <span className="weq-self-field-label">{label}</span>
          <span className="weq-self-field-value" data-privacy-sensitive>
            {value ?? '尚未读取'}
          </span>
          {editable ? (
            <button
              ref={edit}
              type="button"
              title={`编辑${label}`}
              aria-label={`编辑${label}`}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
            </button>
          ) : null}
        </div>
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
          <SaveContext.Provider value={save}>
            {typeof children === 'function' ? children(save) : children}
          </SaveContext.Provider>
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
export function SelfProfileSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="weq-self-card-section">
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
