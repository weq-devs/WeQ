import { useId, useRef, type ReactNode } from 'react';
import '../styles/segmented-control.css';

/** 少量互斥选项共用；禁用项不参与方向键导航，未知值不冒充已选择。 */
export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const enabled = options.filter((option) => !disabled && !option.disabled);
  const tabValue = enabled.find((option) => option.value === value)?.value ?? enabled[0]?.value;
  return (
    <div className="weq-segmented" role="radiogroup" aria-label={label} ref={group}>
      {options.map((option, index) => (
        <button
          key={option.value}
          id={`${id}-${index}`}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          disabled={disabled || option.disabled}
          tabIndex={option.value === tabValue ? 0 : -1}
          onClick={(event) => {
            if (!event.currentTarget.closest('fieldset[disabled]')) onChange(option.value);
          }}
          onKeyDown={(event) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
            if (!keys.includes(event.key)) return;
            const buttons = [
              ...(group.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
            ].filter((button) => !button.matches(':disabled'));
            if (!buttons.length) return;
            event.preventDefault();
            const current = buttons.indexOf(event.currentTarget);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (current +
                      (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
            buttons[next]?.click();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
