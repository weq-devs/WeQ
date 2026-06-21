/**
 * Shared presentational controls for the 设置 panels.
 *
 * Visual language follows the rest of weq: #0099ff accent, thin borders,
 * small radii, light spacing. The toggle is modelled on the relation-graph
 * switch but lives under its own `weq-set-*` classes so the two never couple.
 */

import type { ReactElement, ReactNode } from 'react';

/** Section heading + optional description, shown at the top of each panel. */
export function SectionHeader({
  title,
  desc,
}: {
  title: string;
  desc?: ReactNode;
}): ReactElement {
  return (
    <header className="weq-set-head">
      <h3 className="weq-set-title">{title}</h3>
      {desc ? <p className="weq-set-desc">{desc}</p> : null}
    </header>
  );
}

/** A bordered card grouping related rows, with an optional title + action. */
export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="weq-set-card">
      {title || action ? (
        <div className="weq-set-card-head">
          {title ? <div className="weq-set-card-title">{title}</div> : <span />}
          {action ? <div className="weq-set-card-action">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * A labelled row with arbitrary control on the right (toggle / button / value).
 * `indent` nudges the row right to read as a child of the one above it.
 */
export function Row({
  label,
  desc,
  control,
  indent,
}: {
  label: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
  indent?: boolean;
}): ReactElement {
  return (
    <div className={`weq-set-row${indent ? ' is-indent' : ''}`}>
      <div className="weq-set-row-main">
        <span className="weq-set-row-label">{label}</span>
        {desc ? <span className="weq-set-row-desc">{desc}</span> : null}
      </div>
      <div className="weq-set-row-ctrl">{control}</div>
    </div>
  );
}

/** iOS-style switch. Renders as a `role="switch"` button for a11y. */
export function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={`weq-set-toggle${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="weq-set-toggle-track">
        <span className="weq-set-toggle-knob" />
      </span>
    </button>
  );
}

/** A single checkbox pill, used by the media-type picker. */
export function CheckPill({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className={`weq-set-chk${checked ? ' is-on' : ''}`}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="weq-set-chk-box" aria-hidden />
      <span className="weq-set-chk-label">{children}</span>
    </button>
  );
}
