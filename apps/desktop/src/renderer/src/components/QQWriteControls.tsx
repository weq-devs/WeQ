import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Eraser, Save } from 'lucide-react';
import { Row, Toggle } from './settings/controls';
import '../styles/qq-write.css';

export function QQWriteResult({ result }: { result: { text: string; error: boolean } | null }) {
  return result ? (
    <p className="weq-qq-write-result" role={result.error ? 'alert' : 'status'}>
      {result.text}
    </p>
  ) : null;
}

export function QQWriteTextRow({
  label,
  initial,
  disabled,
  readOnly = false,
  multiline,
  maxLength = 1024,
  allowEmpty = true,
  autoFocus = false,
  onDirtyChange,
  onSave,
}: {
  label: string;
  initial: string | null;
  disabled: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  maxLength?: number;
  allowEmpty?: boolean;
  autoFocus?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial ?? '');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const clearingUnknown = initial === null && allowEmpty && value === '';
  const actionLabel = `${clearingUnknown ? '清空' : '保存'}${label}`;
  const previous = useRef(initial ?? '');
  useEffect(() => {
    const before = previous.current;
    setValue((current) => (current === before ? (initial ?? '') : current));
    previous.current = initial ?? '';
  }, [initial]);
  useEffect(() => {
    onDirtyChange?.(value !== (initial ?? '') && value !== submitted);
  }, [value, initial, submitted, onDirtyChange]);
  if (readOnly)
    return (
      <Row
        label={label}
        control={<span>{initial === null ? '尚未读取' : initial || '未设置'}</span>}
      />
    );
  const input = {
    'aria-label': label,
    className: 'weq-qq-write-input',
    value,
    maxLength,
    required: !allowEmpty,
    disabled,
    autoFocus,
    onChange: (event: { target: { value: string } }) => {
      setValue(event.target.value);
      setSubmitted(null);
    },
  };
  return (
    <Row
      label={label}
      control={
        <div className="weq-qq-write-field">
          {multiline ? <textarea {...input} rows={3} /> : <input {...input} />}
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label={actionLabel}
            title={actionLabel}
            disabled={
              disabled ||
              (!allowEmpty && !value.trim()) ||
              (initial !== null && value === initial) ||
              value === submitted
            }
            onClick={() => {
              void onSave(value).then((ok) => {
                if (ok) setSubmitted(value);
              });
            }}
          >
            {clearingUnknown ? <Eraser size={16} /> : <Save size={16} />}
          </button>
        </div>
      }
    />
  );
}

export function QQWriteSelectRow({
  label,
  initial,
  options,
  disabled,
  onSave,
  preview,
  unlistedLabel,
  autoSave = false,
}: {
  label: string;
  initial: number | null;
  options: readonly { value: number; label: string }[];
  disabled: boolean;
  onSave: (value: number) => Promise<boolean>;
  preview?: (value: number | null) => ReactNode;
  unlistedLabel?: (value: number) => string;
  autoSave?: boolean;
}) {
  const [value, setValue] = useState(initial === null ? '' : String(initial));
  const [submitted, setSubmitted] = useState<string | null>(null);
  const previous = useRef(value);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const latestInitial = useRef(initial);
  latestInitial.current = initial;
  useEffect(() => {
    const next = initial === null ? '' : String(initial);
    const before = previous.current;
    setValue((current) => (current === before ? next : current));
    previous.current = next;
  }, [initial]);
  return (
    <Row
      label={label}
      control={
        <div className={preview ? 'weq-qq-write-select-preview' : undefined}>
          <div className="weq-qq-write-field">
            <select
              className="weq-qq-write-input"
              aria-label={label}
              value={value}
              disabled={disabled || saving}
              onChange={(event) => {
                if (savingRef.current) return;
                const next = event.target.value;
                setValue(next);
                setSubmitted(null);
                if (autoSave && next !== '') {
                  savingRef.current = true;
                  setSaving(true);
                  const rollback = () =>
                    setValue(latestInitial.current === null ? '' : String(latestInitial.current));
                  void onSave(Number(next))
                    .then((ok) => {
                      if (ok) setSubmitted(next);
                      else rollback();
                    }, rollback)
                    .finally(() => {
                      savingRef.current = false;
                      setSaving(false);
                    });
                }
              }}
            >
              {!options.some((option) => String(option.value) === value) && (
                <option value={value}>
                  {value ? (unlistedLabel?.(Number(value)) ?? `未识别 (${value})`) : '尚未读取'}
                </option>
              )}
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {!autoSave ? (
              <button
                type="button"
                className="weq-set-iconbtn"
                aria-label={`保存${label}`}
                title={`保存${label}`}
                disabled={
                  disabled || value === '' || Number(value) === initial || value === submitted
                }
                onClick={() => {
                  void onSave(Number(value)).then((ok) => {
                    if (ok) setSubmitted(value);
                  });
                }}
              >
                <Save size={16} />
              </button>
            ) : null}
          </div>
          {preview?.(value === '' ? null : Number(value))}
        </div>
      }
    />
  );
}

export function QQWriteToggleRow({
  label,
  initial,
  disabled,
  onSave,
}: {
  label: string;
  initial: boolean | null;
  disabled: boolean;
  onSave: (value: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    setDraft(null);
  }, [initial]);
  return (
    <Row
      label={label}
      desc={
        initial === null ? (
          <span role="status">
            {draft === null
              ? '尚未读取'
              : `${saving ? '正在请求' : '已请求'}${draft ? '开启' : '关闭'}，状态待确认`}
          </span>
        ) : undefined
      }
      control={
        <Toggle
          label={label}
          checked={initial ?? draft ?? false}
          indeterminate={initial === null}
          disabled={disabled || saving}
          onChange={async (next) => {
            if (savingRef.current) return;
            savingRef.current = true;
            setSaving(true);
            setDraft(next);
            try {
              await onSave(next);
            } catch {
              setDraft(null);
            } finally {
              savingRef.current = false;
              setSaving(false);
            }
          }}
        />
      }
    />
  );
}

export function QQWriteActionRow({
  label,
  disabled,
  icon,
  onClick,
}: {
  label: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <Row
      label={label}
      control={
        <button type="button" className="weq-set-btn" disabled={disabled} onClick={onClick}>
          {icon}
          {label}
        </button>
      }
    />
  );
}

export function qqWriteNeedsConfirmation(policy: number): boolean {
  return policy === 2 || policy === 3;
}
