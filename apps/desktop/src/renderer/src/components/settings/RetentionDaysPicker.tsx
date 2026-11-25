import { useState } from 'react';
import { Clock3 } from 'lucide-react';
import { IconPicker } from '../ui/iconPicker';

const presets = [1, 3, 7, 14, 30, 90];

export function RetentionDaysPicker({
  label,
  days,
  disabled,
  onChange,
}: {
  label: string;
  days: number | undefined;
  disabled: boolean;
  onChange: (days: number) => void;
}) {
  const [custom, setCustom] = useState(false);
  const showCustom = custom || (days !== undefined && days !== 0 && !presets.includes(days));
  return (
    <div className="weq-diagnostic-inline">
      <IconPicker
        ariaLabel={label}
        triggerIcon={<Clock3 size={14} />}
        placeholder="正在读取…"
        value={days === undefined ? '' : showCustom ? 'custom' : String(days)}
        disabled={disabled}
        onChange={(value) => {
          if (value === 'custom') {
            setCustom(true);
          } else {
            setCustom(false);
            onChange(Number(value));
          }
        }}
        options={[
          ...presets.map((value) => ({ value: String(value), label: `${value} 天` })),
          { value: 'custom', label: '自定义' },
          { value: '0', label: '不限时长' },
        ]}
      />
      {showCustom && (
        <span className="weq-set-unit-field">
          <input
            key={days}
            className="weq-set-input weq-number"
            aria-label={`${label}（天）`}
            type="number"
            min="1"
            max="365"
            defaultValue={days || ''}
            disabled={disabled}
            onBlur={({ currentTarget }) => {
              const next = currentTarget.valueAsNumber;
              currentTarget.value = days ? String(days) : '';
              if (Number.isInteger(next) && next >= 1 && next <= 365 && next !== days)
                onChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className="weq-set-unit">天</span>
        </span>
      )}
    </div>
  );
}
