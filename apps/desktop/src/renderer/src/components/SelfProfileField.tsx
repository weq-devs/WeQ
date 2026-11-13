import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, X } from 'lucide-react';
import { ContactRow } from './contactProfile/ContactRow';
import '../styles/self-profile-card.css';
import { ProfileFieldEditorContext } from './ProfileFieldEditor';
import { useProfileFieldEscape } from '../hooks/useProfileFieldEscape';

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
  auxiliary,
  auxiliaryEditing = false,
  auxiliarySaveDisabled = false,
  onClose,
  rangeOnly = false,
}: {
  label: string;
  value: ReactNode;
  disabled?: boolean;
  children: ReactNode | ((save: Save) => ReactNode);
  onCancel?: () => void;
  renderValue?: (value: ReactNode, editable: boolean) => ReactNode;
  inline?: boolean;
  afterSave?: () => Promise<boolean>;
  editorFooter?: ReactNode;
  onEditingChange?: (editing: boolean) => void;
  unframed?: boolean;
  valueHasAction?: boolean;
  auxiliary?: ReactNode;
  auxiliaryEditing?: boolean;
  auxiliarySaveDisabled?: boolean;
  onClose?: () => void;
  rangeOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const editable = useContext(SelfProfileEditingContext);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const edit = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const [actionTarget, setActionTarget] = useState<HTMLSpanElement | null>(null);
  const active = editing || auxiliaryEditing;
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
    if (!active && restoreFocus.current) {
      restoreFocus.current = false;
      const target = focusReturn.current?.isConnected
        ? focusReturn.current
        : focusReturn.current?.classList.contains('weq-profile-display-summary')
          ? editor.current?.querySelector<HTMLButtonElement>('.weq-profile-display-summary')
          : edit.current;
      target?.focus();
    }
  }, [active]);
  function close() {
    restoreFocus.current = true;
    setEditing(false);
    onEditingChange?.(false);
    onClose?.();
  }
  useProfileFieldEscape(
    editor,
    active,
    () => {
      onCancel?.();
      close();
    },
    pending,
  );
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
  const content = renderValue ? renderValue(value, canEdit && !structured) : (value ?? '尚未读取');
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
            focusReturn.current = event.currentTarget;
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
      {inline || unframed ? (
        fieldContent()
      ) : (
        <ContactRow label={label}>{fieldContent()}</ContactRow>
      )}
    </div>
  );
  function fieldContent() {
    return (
      <div
        ref={editor}
        className={`weq-profile-field-content${active ? ' weq-self-field-editor' : ''}`}
        aria-busy={pending || undefined}
        data-profile-editing={active || undefined}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.weq-profile-display-summary')
          )
            focusReturn.current = event.target.closest<HTMLElement>('.weq-profile-display-summary');
        }}
        onKeyDown={(event) => {
          if (
            !active ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (!running.current) {
              onCancel?.();
              close();
            }
          } else if (
            event.key === 'Enter' &&
            (event.target instanceof HTMLInputElement ||
              (event.target instanceof HTMLTextAreaElement && (event.ctrlKey || event.metaKey)))
          ) {
            event.preventDefault();
            event.stopPropagation();
            editor.current?.querySelector<HTMLButtonElement>('.weq-profile-field-save')?.click();
          }
        }}
      >
        <div className="weq-profile-field-primary">
          {editing ? (
            <fieldset disabled={pending} className="weq-self-field-inputs">
              <SaveContext.Provider value={save}>
                <ProfileFieldEditorContext.Provider
                  value={{ target: actionTarget, disabled: pending }}
                >
                  {typeof children === 'function' ? children(save) : children}
                </ProfileFieldEditorContext.Provider>
              </SaveContext.Provider>
            </fieldset>
          ) : rangeOnly ? null : (
            display
          )}
          {!editing && auxiliary ? (
            <fieldset disabled={pending} className="weq-profile-field-auxiliary">
              {auxiliary}
            </fieldset>
          ) : null}
          {active ? (
            <span className="weq-profile-field-actions">
              <span ref={setActionTarget} className="weq-profile-field-action-target" />
              {!editing ? (
                <button
                  type="button"
                  className="weq-profile-field-tool weq-profile-field-save"
                  title={`保存${label}`}
                  aria-label={`保存${label}`}
                  disabled={pending || auxiliarySaveDisabled}
                  onClick={() => void save(async () => true)}
                >
                  <Check size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="weq-profile-field-tool"
                title={`取消编辑${label}`}
                aria-label={`取消编辑${label}`}
                disabled={pending}
                onClick={() => {
                  onCancel?.();
                  close();
                }}
              >
                <X size={14} />
              </button>
            </span>
          ) : null}
        </div>
        {editing && auxiliary ? (
          <fieldset disabled={pending} className="weq-profile-field-auxiliary">
            {auxiliary}
          </fieldset>
        ) : null}
        {active && editorFooter ? (
          <div className="weq-profile-field-feedback">{editorFooter}</div>
        ) : null}
      </div>
    );
  }
}
