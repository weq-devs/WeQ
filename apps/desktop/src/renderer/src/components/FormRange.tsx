import type { ComponentProps, CSSProperties } from 'react';

export function FormRange({
  min = 0,
  max = 100,
  value,
  style,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'min' | 'max' | 'value'> & {
  min?: number;
  max?: number;
  value: number;
}) {
  const fill = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <input
      {...props}
      type="range"
      min={min}
      max={max}
      value={value}
      style={{ ...style, '--weq-range-fill': `${fill}%` } as CSSProperties}
    />
  );
}
