import { CalendarDays } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { beijingDay } from '../lib/messageCalendar';
import { Modal } from './Dialog';
import { MessageCalendar } from './MessageCalendar';
import { NumericText } from './NumericText';

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function CalendarDateField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  clearable = true,
}: {
  label: string;
  value: string;
  onChange: (day: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  clearable?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [month, setMonth] = useState('');
  const canChoose = (day: string) => validDate(day) && (!min || day >= min) && (!max || day <= max);

  function show() {
    const today = beijingDay();
    const focusDay = value || (min && today < min ? min : max && today > max ? max : today);
    trigger.current?.focus({ preventScroll: true });
    setOpen(true);
    setMonth(focusDay.slice(0, 7));
    setDraft(value);
  }

  const firstYear = min ? Number(min.slice(0, 4)) : 1970;
  const lastYear = max ? Number(max.slice(0, 4)) : Number(beijingDay().slice(0, 4)) + 5;
  const yearOptions = open
    ? Array.from({ length: Math.max(0, lastYear - firstYear + 1) }, (_, index) =>
        String(firstYear + index),
      )
    : undefined;

  function choose(day: string) {
    onChange(day);
    setOpen(false);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="weq-select-trigger weq-date-filter"
        aria-label={value ? `${label}：${value}` : label}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        disabled={disabled}
        data-placeholder={!value || undefined}
        onClick={show}
      >
        <span className="weq-select-value">
          {value ? <NumericText>{value}</NumericText> : '选择日期'}
        </span>
        <CalendarDays className="weq-select-arrow" size={14} aria-hidden />
      </button>
      {open && !disabled && (
        <Modal
          presentation="popover"
          anchor={trigger.current}
          portalTarget={trigger.current?.closest('[data-field-popup-host]')}
          anchorPlacement="below"
          labelledBy={id}
          width={318}
          className="weq-date-filter-dialog"
          onClose={() => setOpen(false)}
        >
          <strong id={id}>{label}</strong>
          <form
            className="weq-date-filter-entry"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (canChoose(draft)) choose(draft);
            }}
          >
            <input
              className="weq-set-input"
              aria-label="输入日期（年-月-日）"
              placeholder="YYYY-MM-DD"
              autoComplete="off"
              maxLength={10}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="weq-set-btn" disabled={!canChoose(draft)}>
              确定
            </button>
            {clearable && (value || draft) && (
              <button type="button" className="weq-set-btn" onClick={() => choose('')}>
                清除
              </button>
            )}
          </form>
          <MessageCalendar
            start={value}
            end={value}
            minDay={min}
            maxDay={max}
            dateOnly
            statusText="北京时间"
            allowEmpty
            month={month}
            onMonthChange={setMonth}
            yearOptions={yearOptions}
            onPick={choose}
          />
        </Modal>
      )}
    </>
  );
}
