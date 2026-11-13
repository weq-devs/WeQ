import { useLayoutEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ContactRow } from './contactProfile/ContactRow';
import '../styles/group-member-edit.css';

/** 名片资料共用的原行编辑器，保存失败时保留输入。 */
export function ProfileInlineField({
  label,
  initial,
  editable,
  disabled,
  onSave,
  initialEditing = false,
  maxLength = 256,
  allowEmpty = true,
  placeholder,
  valueClassName,
  options,
  onCancel,
}: {
  label: string;
  initial: string;
  editable: boolean;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
  initialEditing?: boolean;
  maxLength?: number;
  allowEmpty?: boolean;
  placeholder?: string;
  valueClassName?: string;
  options?: readonly { value: string; label: string }[];
  onCancel?: () => void;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const locked = disabled || saving;
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);
  function cancel() {
    restoreFocus.current = true;
    setEditing(false);
    onCancel?.();
  }
  return editing && editable ? (
    <form
      className="weq-member-inline-field"
      data-qq-action
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (!running.current) cancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || running.current || (!allowEmpty && !draft.trim())) return;
        running.current = true;
        setSaving(true);
        void onSave(draft)
          .then((ok) => {
            if (ok) setEditing(false);
          })
          .finally(() => {
            running.current = false;
            setSaving(false);
          });
      }}
    >
      <label>
        <span>{label}</span>
        {options ? (
          <select
            aria-label={label}
            value={draft}
            disabled={locked}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          >
            {!options.some((option) => option.value === draft) ? (
              <option value={draft} disabled>
                选择分组
              </option>
            ) : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={label}
            value={draft}
            maxLength={maxLength}
            required={!allowEmpty}
            disabled={locked}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </label>
      <button
        type="submit"
        className="weq-profile-row-copy"
        aria-label={`保存${label}`}
        title={`保存${label}`}
        disabled={
          locked ||
          (!allowEmpty && !draft.trim()) ||
          Boolean(options && !options.some((option) => option.value === draft))
        }
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        className="weq-profile-row-copy"
        aria-label={`取消编辑${label}`}
        title="取消编辑"
        disabled={locked}
        onClick={cancel}
      >
        <X size={14} />
      </button>
    </form>
  ) : (
    <ContactRow label={label} valueClassName={valueClassName}>
      {editable && !locked ? (
        <button
          ref={trigger}
          type="button"
          className="weq-contact-value"
          aria-label={`编辑${label}`}
          title={`编辑${label}`}
          disabled={locked}
          onClick={(event) => {
            const selection = event.currentTarget.ownerDocument.getSelection();
            if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
            setDraft(initial);
            setEditing(true);
          }}
        >
          {options?.find((option) => option.value === initial)?.label ||
            initial ||
            placeholder ||
            `设置${label}`}
        </button>
      ) : (
        options?.find((option) => option.value === initial)?.label || initial || null
      )}
    </ContactRow>
  );
}
