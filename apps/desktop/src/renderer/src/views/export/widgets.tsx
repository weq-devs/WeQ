/**
 * Small shared presentational widgets for the export hub. Visual language
 * follows the rest of weq: #0099ff accent, thin borders, small radii.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/** Segmented control (single choice). Mirrors the relation-graph segmented. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  small,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode }>;
  small?: boolean;
}): ReactElement {
  return (
    <div className={`weq-exp-seg${small ? ' is-small' : ''}`} role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={opt.value === value ? 'is-active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Spinning loader glyph at a given pixel size. */
export function Spinner({ size = 16 }: { size?: number }): ReactElement {
  return <Loader2 size={size} className="weq-exp-spin" strokeWidth={2} aria-hidden />;
}

/** Round avatar that falls back to an initial letter on missing / broken src. */
export function Avatar({
  url,
  name,
  size = 36,
}: {
  url: string | null | undefined;
  name: string;
  size?: number;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const showImg = url && !failed;
  return (
    <span className="weq-exp-avatar" style={{ width: size, height: size }}>
      {showImg ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="weq-exp-avatar-fb">{(name || '?').slice(0, 1)}</span>
      )}
    </span>
  );
}
