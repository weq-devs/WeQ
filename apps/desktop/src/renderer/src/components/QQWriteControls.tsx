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
  multiline,
  maxLength = 1024,
  allowEmpty = true,
  onSave,
}: {
  label: string;
  initial: string | null;
  disabled: boolean;
  multiline?: boolean;
  maxLength?: number;
  allowEmpty?: boolean;
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
  const input = {
    'aria-label': label,
    className: 'weq-qq-write-input',
    value,
    maxLength,
    required: !allowEmpty,
    disabled,
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
}: {
  label: string;
  initial: number | null;
  options: readonly { value: number; label: string }[];
  disabled: boolean;
  onSave: (value: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial === null ? '' : String(initial));
  const [submitted, setSubmitted] = useState<string | null>(null);
  const previous = useRef(value);
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
        <div className="weq-qq-write-field">
          <select
            className="weq-qq-write-input"
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              setValue(event.target.value);
              setSubmitted(null);
            }}
          >
            {!options.some((option) => String(option.value) === value) && (
              <option value={value}>{value ? `未识别 (${value})` : '尚未读取'}</option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label={`保存${label}`}
            title={`保存${label}`}
            disabled={disabled || value === '' || Number(value) === initial || value === submitted}
            onClick={() => {
              void onSave(Number(value)).then((ok) => {
                if (ok) setSubmitted(value);
              });
            }}
          >
            <Save size={16} />
          </button>
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
  const [pending, setPending] = useState<boolean | null>(null);
  if (initial === null)
    return (
      <QQWriteSelectRow
        label={label}
        initial={null}
        disabled={disabled}
        options={[
          { value: 0, label: '关闭' },
          { value: 1, label: '开启' },
        ]}
        onSave={(value) => onSave(value === 1)}
      />
    );
  return (
    <Row
      label={label}
      control={
        <Toggle
          label={label}
          checked={initial ?? false}
          disabled={disabled || (pending !== null && pending !== initial)}
          onChange={(next) => {
            void onSave(next).then((ok) => {
              if (ok) setPending(next);
            });
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
