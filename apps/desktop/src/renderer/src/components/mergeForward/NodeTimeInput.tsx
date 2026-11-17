import { useEffect, useState } from 'react';
import '../../styles/composition-time.css';
import { nodeTimeValue, MAX_MESSAGE_TIME, parseNodeTime } from './NodeTimeInput.shared';

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
