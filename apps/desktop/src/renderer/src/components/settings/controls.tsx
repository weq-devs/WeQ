/**
 * Shared presentational controls for the 设置 panels.
 *
 * Visual language follows the rest of weq: #0099ff accent, thin borders,
 * small radii, light spacing. The toggle is modelled on the relation-graph
 * switch but lives under its own `weq-set-*` classes so the two never couple.
 */

import {
  createContext,
  useContext,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import type { SettingsScope } from './navigation';

export const SettingsScopeContext = createContext<SettingsScope | null>(null);

export function SettingsScopeBadge() {
  const scope = useContext(SettingsScopeContext);
  return scope ? <span className="weq-settings-scope">{scope.label}</span> : null;
}

/** Section heading + optional description (and optional leading icon), shown at the top of each panel. */
export function SectionHeader({
  title,
  desc,
  icon,
  titleClassName,
}: {
  title: string;
  desc?: ReactNode;
  icon?: ReactNode;
  titleClassName?: string;
}): ReactElement {
  const scope = useContext(SettingsScopeContext);
  return (
    <header className="weq-set-head">
      <div className="weq-set-head-title">
        {icon ? (
          <span className="weq-set-head-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <h3 className={`weq-set-title${titleClassName ? ` ${titleClassName}` : ''}`}>{title}</h3>
        <SettingsScopeBadge />
      </div>
      {desc ? <p className="weq-set-desc">{desc}</p> : null}
      {scope?.detail ? <p className="weq-set-desc">{scope.detail}</p> : null}
    </header>
  );
}

/** A bordered card grouping related rows, with an optional title + action. */
export function Card({
  title,
  icon,
  action,
  children,
}: {
  title?: string;
  /** 标题前的图标（lucide 组件或资源图），与设置页各分区的视觉语言保持一致。 */
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="weq-set-card">
      {title || action ? (
        <div className="weq-set-card-head">
          {title ? (
            <div className="weq-set-card-title">
              {icon ? (
                <span className="weq-set-card-icon" aria-hidden>
                  {icon}
                </span>
              ) : null}
              {title}
            </div>
          ) : (
            <span />
          )}
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

export function CheckPillGroup<T extends string>({
  options,
  selected,
  onChange,
  disabled = false,
}: {
  options: readonly { value: T; label: ReactNode }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  disabled?: boolean;
}) {
  const multi = useMultiSelection({
    ids: options.map((option) => option.value),
    selected: new Set(selected),
    onChange: (next) => onChange([...next]),
    disabled,
  });
  return (
    <div className="weq-set-pill-group" {...multi.rootProps}>
      {options.map((option) => (
        <CheckPill
          key={option.value}
          checked={selected.includes(option.value)}
          disabled={disabled}
          onChange={() => multi.toggle(option.value)}
          {...multi.itemProps(option.value)}
        >
          {option.label}
        </CheckPill>
      ))}
    </div>
  );
}

/** A single checkbox pill, used by the media-type picker. */
export function CheckPill({
  checked,
  disabled,
  onChange,
  children,
  ...buttonProps
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>): ReactElement {
  return (
    <button
      {...buttonProps}
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
