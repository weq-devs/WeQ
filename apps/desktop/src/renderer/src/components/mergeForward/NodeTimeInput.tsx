import { useEffect, useState } from 'react';
import '../../styles/composition-time.css';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_MESSAGE_TIME = 0xffff_ffff;

export function nodeTimeValue(seconds: number): string {
  return new Date(seconds * 1000 + BEIJING_OFFSET_MS).toISOString().slice(0, 19);
}

export function parseNodeTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const seconds = Date.parse(`${value}+08:00`) / 1000;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_MESSAGE_TIME) return null;
  // Date.parse 会把二月三十日等无效日期进位，不能静默改成另一日。
  if (nodeTimeValue(seconds).slice(0, value.length) !== value) return null;
  return seconds;
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
