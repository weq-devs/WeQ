/**
 * Shared presentational controls for the 设置 panels.
 *
 * 颜色跟随主题语义 token；控件沿用设置页的密度、细描边和小圆角。
 * 开关使用独立 weq-set-* 类名，不与关系图等业务组件耦合。
 */

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import type { SettingsScope } from './navigation';
import { RefreshCw } from 'lucide-react';
import '../../styles/settings-query.css';
import '../../styles/settings-controls.css';
import { SettingsResetCardContext, SettingsResetContext } from './resetContext';
import { SettingsResetButton } from './SettingsReset';
import { SETTINGS_RESET_CARDS, type SettingsResetCardId } from '../../../../shared/settings_reset';
import {
  remoteResetCardAvailable,
  remoteSettingAvailable,
} from '../../../../shared/remote_capabilities';
import { useRemoteClient } from '../../lib/remoteClient';

/** 查询失败不冒充空配置；有缓存时由调用方继续展示原数据。 */
export function QueryError({
  message,
  retryLabel,
  retrying,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  retrying?: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="weq-settings-query-error" role="alert">
      <span>{message}</span>
      <button
        type="button"
        title={retryLabel}
        aria-label={retryLabel}
        disabled={retrying}
        onClick={onRetry}
      >
        <RefreshCw size={14} className={retrying ? 'weq-spin' : undefined} aria-hidden />
      </button>
    </div>
  );
}

export const SettingsScopeContext = createContext<SettingsScope | null>(null);

/**
 * 卡片 head 右侧的保存状态位。`AutoSave` 有槽位时把「正在保存／已保存／失败」
 * 放进卡片标题行，避免它挤在行描述的位置上被当成人话说明。
 */
export const SaveStatusSlotContext = createContext<{ take: () => HTMLElement | null } | null>(null);

export function SettingsScopeBadge() {
  const scope = useContext(SettingsScopeContext);
  return scope ? <span className="weq-settings-scope">{scope.label}</span> : null;
}

/**
 * 在设置页之间跳转。由 `SettingsDialog` 提供，页面里的「去管理」这类入口消费。
 * 不提供时（例如单测直接渲染某个 section）为 `null`，调用方应自行降级。
 */
export const SettingsNavigateContext = createContext<((section: string) => void) | null>(null);

/** Section heading + optional description (and optional leading icon), shown at the top of each panel. */
export function SectionHeader({
  title,
  desc,
  icon,
  titleClassName,
  badge,
  actions,
  pageReset = true,
}: {
  title: string;
  desc?: ReactNode;
  icon?: ReactNode;
  titleClassName?: string;
  /** 标题旁的固定说明（例如「自动保存」），只描述保存方式，不放操作。 */
  badge?: ReactNode;
  /** 页头右侧的常驻操作（主操作不折叠进菜单）。 */
  actions?: ReactNode;
  pageReset?: boolean;
}): ReactElement {
  const scope = useContext(SettingsScopeContext);
  const reset = useContext(SettingsResetContext);
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
        {badge ? <span className="weq-set-badge">{badge}</span> : null}
      </div>
      {actions || (reset && pageReset) ? (
        <div
          className="weq-settings-page-reset"
          data-setting-id={
            reset && pageReset
              ? reset.page === 'startup'
                ? 'weq-config-management'
                : `settings-reset-${reset.page}`
              : undefined
          }
        >
          {actions}
          {reset && pageReset ? <SettingsResetButton /> : null}
        </div>
      ) : null}
      {desc ? <p className="weq-set-desc">{desc}</p> : null}
      {scope?.detail ? <p className="weq-set-desc">{scope.detail}</p> : null}
    </header>
  );
}

/** A bordered card grouping related rows, with an optional title + action. */
export function Card({
  settingId,
  title,
  desc,
  icon,
  action,
  resetId,
  remoteUnsupported = false,
  children,
}: {
  settingId?: string;
  title?: string;
  /** 卡片标题下的一句说明，与页头 `SectionHeader` 的 desc 同一套字号/颜色。 */
  desc?: ReactNode;
  /** 标题前的图标（lucide 组件或资源图），与设置页各分区的视觉语言保持一致。 */
  icon?: ReactNode;
  action?: ReactNode;
  resetId?: SettingsResetCardId;
  remoteUnsupported?: boolean;
  children?: ReactNode;
}): ReactElement | null {
  const reset = useContext(SettingsResetContext);
  const remote = useRemoteClient();
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const statusSlotTaken = useRef(false);
  const statusSlotApi = useMemo(
    () => ({
      // 一张卡只把一个状态文字放进 head，其余仍在行内显示，避免重复「已保存」。
      take: () => {
        if (!statusSlot || statusSlotTaken.current) return null;
        statusSlotTaken.current = true;
        return statusSlot;
      },
    }),
    [statusSlot],
  );
  if (remote && (remoteUnsupported || !remoteSettingAvailable('', settingId))) return null;
  const card =
    resetId ??
    SETTINGS_RESET_CARDS.find(([page, , label]) => page === reset?.page && title === label)?.[1];
  const canReset = card && (!remote || remoteResetCardAvailable(card));
  return (
    <SettingsResetCardContext.Provider value={reset && card ? reset.saves(card) : null}>
      <section className="weq-set-card" data-setting-id={settingId}>
        {title || action || card ? (
          <div className="weq-set-card-head">
            <div className="weq-set-card-heading">
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
              {desc ? <p className="weq-set-card-desc">{desc}</p> : null}
            </div>
            <div className="weq-set-card-action">
              <span className="weq-set-card-status" ref={setStatusSlot} />
              {action}
              {canReset ? <SettingsResetButton card={card} /> : null}
            </div>
          </div>
        ) : null}
        <SaveStatusSlotContext.Provider value={statusSlotApi}>
          {children}
        </SaveStatusSlotContext.Provider>
      </section>
    </SettingsResetCardContext.Provider>
  );
}

/**
 * A labelled row with arbitrary control on the right (toggle / button / value).
 * `indent` nudges the row right to read as a child of the one above it.
 */
export function Row({
  settingId,
  label,
  desc,
  control,
  indent,
  remoteUnsupported = false,
}: {
  settingId?: string;
  label: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
  indent?: boolean;
  remoteUnsupported?: boolean;
}): ReactElement | null {
  const remote = useRemoteClient();
  if (remote && (remoteUnsupported || !remoteSettingAvailable('', settingId))) return null;
  return (
    <div className={`weq-set-row${indent ? ' is-indent' : ''}`} data-setting-id={settingId}>
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
  indeterminate = false,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={`weq-set-toggle${indeterminate ? ' is-unknown' : checked ? ' is-on' : ''}`}
      role={indeterminate ? 'checkbox' : 'switch'}
      aria-checked={indeterminate ? 'mixed' : checked}
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
  optionDisabled,
}: {
  options: readonly { value: T; label: ReactNode }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  disabled?: boolean;
  /** 单个选项不可用（例如当前范围不支持该格式），仍展示但不可勾选。 */
  optionDisabled?: (value: T) => boolean;
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
          disabled={disabled || (optionDisabled?.(option.value) ?? false)}
          onChange={() => multi.toggle(option.value)}
          {...multi.itemProps(option.value, optionDisabled?.(option.value) ?? false)}
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
