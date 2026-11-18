/**
 * Shared presentational controls for the 设置 panels.
 *
 * 颜色跟随主题语义 token；控件沿用设置页的密度、细描边和小圆角。
 * 开关使用独立 weq-set-* 类名，不与关系图等业务组件耦合。
 */

import {
  useContext,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
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
import { findSettingDefinition } from '@weq/service/settings-catalog';
import { SettingsPageIcon } from './pageIcons';
import type { SettingsPageId } from './navigation';
import { SettingsScopeContext, SaveStatusSlotContext } from './controls.shared';

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

export function SettingsScopeBadge() {
  const scope = useContext(SettingsScopeContext);
  return scope ? <span className="weq-settings-scope">{scope.label}</span> : null;
}

/** Section heading + optional description (and optional leading icon), shown at the top of each panel. */
export function SectionHeader({
  title,
  desc,
  icon,
  page,
  titleClassName,
  badge,
  actions,
  pageReset = true,
}: {
  title: string;
  desc?: ReactNode;
  icon?: ReactNode;
  /** 设置页面的标题与二级导航使用同一图标。 */
  page?: SettingsPageId;
  titleClassName?: string;
  /** 标题旁的固定说明（例如「自动保存」），只描述保存方式，不放操作。 */
  badge?: ReactNode;
  /** 页头右侧的常驻操作（主操作不折叠进菜单）。 */
  actions?: ReactNode;
  pageReset?: boolean;
}): ReactElement {
  const scope = useContext(SettingsScopeContext);
  const reset = useContext(SettingsResetContext);
  const headingIcon = page ? <SettingsPageIcon page={page} /> : icon;
  return (
    <header className="weq-set-head">
      <div className="weq-set-head-title">
        {headingIcon ? (
          <span className="weq-set-head-icon" aria-hidden>
            {headingIcon}
          </span>
        ) : null}
        <h3 className={`weq-set-title${titleClassName ? ` ${titleClassName}` : ''}`}>{title}</h3>
        <SettingsScopeBadge />
        {badge ? <span className="weq-set-badge">{badge}</span> : null}
      </div>
      {actions || (reset && pageReset) ? (
        <div
          className="weq-settings-page-reset"
          data-setting-id={reset && pageReset ? `settings-reset-${reset.page}` : undefined}
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
  title: titleOverride,
  titleBadge,
  desc,
  icon,
  action,
  resetId,
  remoteUnsupported = false,
  children,
}: {
  settingId?: string;
  title?: string;
  titleBadge?: ReactNode;
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
  const title =
    titleOverride ??
    (resetId ? SETTINGS_RESET_CARDS.find(([, id]) => id === resetId)?.[2] : undefined);
  const identity = settingId ?? (resetId && findSettingDefinition(resetId) ? resetId : undefined);
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
      <section className="weq-set-card" data-setting-id={identity}>
        {title || action || card ? (
          <div className="weq-set-card-head">
            <div className="weq-set-card-heading">
              {titleBadge ? (
                <div className="weq-set-card-title-line">
                  <div className="weq-set-card-title">
                    {icon ? (
                      <span className="weq-set-card-icon" aria-hidden>
                        {icon}
                      </span>
                    ) : null}
                    {title}
                  </div>
                  {titleBadge}
                </div>
              ) : title ? (
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
  label?: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
  indent?: boolean;
  remoteUnsupported?: boolean;
}): ReactElement | null {
  const remote = useRemoteClient();
  const definition = settingId ? findSettingDefinition(settingId) : undefined;
  const rowLabel = label === undefined ? definition?.label : label;
  if (remote && (remoteUnsupported || !remoteSettingAvailable('', settingId))) return null;
  return (
    <div className={`weq-set-row${indent ? ' is-indent' : ''}`} data-setting-id={settingId}>
      <div className="weq-set-row-main">
        <span className="weq-set-row-label">{rowLabel}</span>
        {desc ? <span className="weq-set-row-desc">{desc}</span> : null}
      </div>
      <div className="weq-set-row-ctrl">{control}</div>
    </div>
  );
}

/** mixed 表示部分开启，点击请求全开；indeterminate 保留既有“尚未读取”的双向请求。 */
export function Toggle({
  checked,
  mixed,
  indeterminate = false,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  /** 分组汇总状态；显式传入 false 时仍维持 checkbox 语义。 */
  mixed?: boolean;
  /** 尚未读取，保留根据 checked 请求相反值的旧行为。 */
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={`weq-set-toggle${mixed ? ' is-mixed' : indeterminate ? ' is-unknown' : checked ? ' is-on' : ''}`}
      role={mixed !== undefined || indeterminate ? 'checkbox' : 'switch'}
      aria-checked={mixed || indeterminate ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(mixed || !checked)}
    >
      <span className="weq-set-toggle-track" aria-hidden="true">
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
