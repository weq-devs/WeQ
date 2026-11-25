import { useState, type ReactNode } from 'react';
import { Clock3, Database } from 'lucide-react';
import { HISTORY_CAPACITY_OPTIONS, MAX_HISTORY_CAPACITY_MIB } from '@weq/service/settings-catalog';
import { IconPicker } from '../ui/iconPicker';

const dayOptions = [1, 3, 7, 14, 30, 90].map((days) => ({
  value: String(days),
  label: `${days} 天`,
}));

interface PickerProps {
  label: string;
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number) => void;
}

export function RetentionDaysPicker(props: PickerProps) {
  return (
    <RetentionPicker
      {...props}
      icon={<Clock3 size={14} />}
      presets={dayOptions}
      unlimitedLabel="不限时长"
      unit="天"
      max={365}
    />
  );
}

export function RetentionCapacityPicker(props: PickerProps) {
  return (
    <RetentionPicker
      {...props}
      icon={<Database size={14} />}
      presets={HISTORY_CAPACITY_OPTIONS}
      unlimitedLabel="不限容量"
      unit="MiB"
      max={MAX_HISTORY_CAPACITY_MIB}
    />
  );
}

function RetentionPicker({
  label,
  value,
  disabled,
  onChange,
  icon,
  presets,
  unlimitedLabel,
  unit,
  max,
}: PickerProps & {
  icon: ReactNode;
  presets: readonly { value: string; label: string }[];
  unlimitedLabel: string;
  unit: string;
  max: number;
}) {
  const [custom, setCustom] = useState(false);
  const preset = value === 0 || presets.some((option) => option.value === String(value));
  const showCustom = custom || (value !== undefined && !preset);
  return (
    <div className="weq-diagnostic-inline">
      <IconPicker
        ariaLabel={label}
        triggerIcon={icon}
        placeholder="正在读取…"
        value={value === undefined ? '' : showCustom ? 'custom' : String(value)}
        disabled={disabled}
        onChange={(option) => {
          setCustom(option === 'custom');
          if (option !== 'custom') onChange(Number(option));
        }}
        options={[
          ...presets,
          { value: 'custom', label: '自定义' },
          { value: '0', label: unlimitedLabel },
        ]}
      />
      {showCustom && (
        <span className="weq-set-unit-field">
          <input
            key={value}
            className="weq-set-input weq-number"
            aria-label={`${label}（${unit}）`}
            type="number"
            min={1}
            max={max}
            defaultValue={value || ''}
            disabled={disabled}
            onBlur={({ currentTarget }) => {
              const next = currentTarget.valueAsNumber;
              currentTarget.value = value ? String(value) : '';
              if (Number.isInteger(next) && next >= 1 && next <= max && next !== value)
                onChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span className="weq-set-unit">{unit}</span>
        </span>
      )}
    </div>
  );
}
