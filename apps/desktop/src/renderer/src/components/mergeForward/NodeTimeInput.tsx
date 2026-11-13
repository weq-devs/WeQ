import { formatDateTimeInput, parseDateTimeInput } from '@weq/time';
import { useEffect, useState } from 'react';
import '../../styles/composition-time.css';

const MAX_MESSAGE_TIME = 0xffff_ffff;

export function nodeTimeValue(seconds: number): string {
  return formatDateTimeInput(seconds * 1000);
}

export function parseNodeTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const ms = parseDateTimeInput(value);
  const seconds = ms === null ? null : ms / 1000;
  return seconds !== null &&
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= MAX_MESSAGE_TIME
    ? seconds
    : null;
}

export function NodeTimeInput({
  time,
  onChange,
}: {
  time: number;
  onChange: (time: number) => void;
}) {
  const [value, setValue] = useState(() => nodeTimeValue(time));
  useEffect(() => setValue(nodeTimeValue(time)), [time]);
  return (
    <input
      className="weq-composition-time"
      type="datetime-local"
      aria-label="消息时间（北京时间）"
      title="消息时间（北京时间）"
      step={1}
      min={nodeTimeValue(1)}
      max={nodeTimeValue(MAX_MESSAGE_TIME)}
      value={value}
      aria-invalid={parseNodeTime(value) === null}
      onChange={(event) => {
        setValue(event.target.value);
        const next = parseNodeTime(event.target.value);
        if (next !== null) onChange(next);
      }}
      onBlur={() => setValue(nodeTimeValue(time))}
    />
  );
}
